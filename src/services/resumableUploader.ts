import { ClientUploadProgress, VideoMetadata } from '../types/index.ts';

const SESSION_STORAGE_KEY = 'clipgenius_active_upload_session';

// Safe native fetch wrapper: invokes native browser fetch without overriding global properties
async function safeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const fetchFn = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : globalThis.fetch;
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('clipgenius_owner_token') : null;
  const headers = new Headers(init.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetchFn(input, {
    credentials: 'include',
    ...init,
    headers,
  });
}

export interface ResumableUploaderOptions {
  chunkSize?: number; // bytes (e.g., 10 * 1024 * 1024)
  onProgress?: (progress: ClientUploadProgress) => void;
  onError?: (error: Error) => void;
  onComplete?: (video: VideoMetadata) => void;
}

export class ResumableUploader {
  private file: File;
  private chunkSize: number;
  private uploadId: string | null = null;
  private isPaused: boolean = false;
  private isCancelled: boolean = false;
  private onProgress?: (progress: ClientUploadProgress) => void;
  private onError?: (error: Error) => void;
  private onComplete?: (video: VideoMetadata) => void;

  private totalChunks: number;
  private receivedChunks: Set<number> = new Set();
  private startTime: number = 0;
  private lastProgressTime: number = 0;
  private lastProgressBytes: number = 0;

  constructor(file: File, options: ResumableUploaderOptions = {}) {
    this.file = file;
    // Default chunk size: 10 MB for fast streaming and low gateway timeout risk
    this.chunkSize = options.chunkSize || 10 * 1024 * 1024;
    this.totalChunks = Math.ceil(file.size / this.chunkSize);
    this.onProgress = options.onProgress;
    this.onError = options.onError;
    this.onComplete = options.onComplete;
  }

  /**
   * Starts or resumes the upload process
   */
  public async start(): Promise<VideoMetadata> {
    this.isPaused = false;
    this.isCancelled = false;
    this.startTime = Date.now();
    this.lastProgressTime = Date.now();
    this.lastProgressBytes = 0;

    try {
      // 1. Check for saved upload session in localStorage
      const savedSession = this.getSavedSession();

      if (savedSession && savedSession.filename === this.file.name && savedSession.totalSize === this.file.size) {
        // Verify with server if this session is still valid
        const isVerified = await this.verifySession(savedSession.uploadId);
        if (isVerified) {
          this.uploadId = savedSession.uploadId;
        } else {
          await this.initNewSession();
        }
      } else {
        await this.initNewSession();
      }

      this.saveSession();

      // 2. Upload missing chunks sequentially
      for (let i = 0; i < this.totalChunks; i++) {
        if (this.isCancelled) {
          throw new Error('Upload cancelled by user');
        }

        if (this.isPaused) {
          this.emitProgress(i, 'paused');
          return new Promise((_, reject) => {
            reject(new Error('Upload paused'));
          });
        }

        if (this.receivedChunks.has(i)) {
          // Chunk already received previously, skip re-uploading!
          continue;
        }

        const start = i * this.chunkSize;
        const end = Math.min(this.file.size, start + this.chunkSize);
        const chunkBlob = this.file.slice(start, end);

        await this.uploadChunkWithRetry(i, chunkBlob, 3);
        this.receivedChunks.add(i);

        this.emitProgress(i + 1, 'uploading');
      }

      // 3. Complete and assemble upload on server
      this.emitProgress(this.totalChunks, 'assembling');

      const completeRes = await safeFetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: this.uploadId }),
      });

      const completeData = await completeRes.json();
      if (!completeRes.ok) {
        throw new Error(completeData.error || 'Server failed to assemble and probe video');
      }

      this.emitProgress(this.totalChunks, 'completed');
      this.clearSavedSession();

      if (this.onComplete) {
        this.onComplete(completeData.video);
      }

      return completeData.video;
    } catch (err) {
      if (!this.isPaused && !this.isCancelled) {
        this.emitProgress(0, 'error', (err as Error).message);
        if (this.onError) {
          this.onError(err as Error);
        }
      }
      throw err;
    }
  }

  public pause(): void {
    this.isPaused = true;
    this.emitProgress(this.receivedChunks.size, 'paused');
  }

  public resume(): Promise<VideoMetadata> {
    return this.start();
  }

  public async cancel(): Promise<void> {
    this.isCancelled = true;
    this.isPaused = false;
    if (this.uploadId) {
      await safeFetch(`/api/upload/cancel/${this.uploadId}`, { method: 'DELETE' }).catch(() => {});
    }
    this.clearSavedSession();
    this.emitProgress(0, 'idle');
  }

  private async initNewSession(): Promise<void> {
    const res = await safeFetch('/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: this.file.name,
        totalSize: this.file.size,
        chunkSize: this.chunkSize,
        mimeType: this.file.type || 'video/mp4',
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to initialize resumable upload session');
    }

    this.uploadId = data.session.uploadId;
    this.receivedChunks = new Set(data.session.receivedChunks || []);
  }

  private async verifySession(uploadId: string): Promise<boolean> {
    try {
      const res = await safeFetch(`/api/upload/status/${uploadId}`);
      if (!res.ok) return false;
      const data = await res.json();
      if (data.status === 'active') {
        this.receivedChunks = new Set(data.receivedChunks || []);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async uploadChunkWithRetry(
    chunkIndex: number,
    chunkBlob: Blob,
    maxRetries: number = 3
  ): Promise<void> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const res = await safeFetch('/api/upload/chunk', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-upload-id': this.uploadId!,
            'x-chunk-index': chunkIndex.toString(),
            'x-chunk-size': chunkBlob.size.toString(),
          },
          body: chunkBlob,
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status} uploading chunk ${chunkIndex}`);
        }

        return;
      } catch (err) {
        attempt++;
        if (attempt >= maxRetries) {
          throw err;
        }
        // Exponential backoff wait (500ms, 1000ms, 2000ms)
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
      }
    }
  }

  private emitProgress(
    currentChunkIndex: number,
    status: ClientUploadProgress['status'],
    error?: string
  ): void {
    if (!this.onProgress) return;

    const uploadedBytes = Math.min(
      this.file.size,
      this.receivedChunks.size * this.chunkSize
    );

    const now = Date.now();
    const timeDiffSecs = Math.max(0.1, (now - this.lastProgressTime) / 1000);
    const bytesDiff = Math.max(0, uploadedBytes - this.lastProgressBytes);

    let speedBytesPerSec = Math.round(bytesDiff / timeDiffSecs);
    if (speedBytesPerSec <= 0) {
      const totalElapsed = Math.max(1, (now - this.startTime) / 1000);
      speedBytesPerSec = Math.round(uploadedBytes / totalElapsed);
    }

    const remainingBytes = Math.max(0, this.file.size - uploadedBytes);
    const etaSeconds = speedBytesPerSec > 0 ? Math.round(remainingBytes / speedBytesPerSec) : 0;

    const percent = Math.min(100, Math.round((uploadedBytes / this.file.size) * 100));

    this.lastProgressTime = now;
    this.lastProgressBytes = uploadedBytes;

    this.onProgress({
      uploadId: this.uploadId || '',
      filename: this.file.name,
      totalSize: this.file.size,
      uploadedBytes,
      percent,
      chunkIndex: currentChunkIndex,
      totalChunks: this.totalChunks,
      speedBytesPerSec,
      etaSeconds,
      status,
      error,
    });
  }

  private getSavedSession(): { uploadId: string; filename: string; totalSize: number } | null {
    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private saveSession(): void {
    if (this.uploadId) {
      localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          uploadId: this.uploadId,
          filename: this.file.name,
          totalSize: this.file.size,
        })
      );
    }
  }

  private clearSavedSession(): void {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }
}
