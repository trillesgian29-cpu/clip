import {
  VideoMetadata,
  ClipSuggestion,
  RenderJob,
  ProjectData,
  SystemStatus,
  PublishedClip,
  AnalysisAuditReport,
  OpenRouterDetails,
  AiProviderMode,
  EditorialCurationStyle,
  TranscriptVerificationInfo,
} from '../types/index.ts';
import { getSupabaseClient } from './supabaseClient.ts';

const TOKEN_KEY = 'clipgenius_owner_token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function getAuthHeaders(includeContentType = true): Record<string, string> {
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// Safe native fetch wrapper: invokes native browser fetch without overriding global properties
// and sends same-origin session cookies + auth headers cleanly
async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const fetchFn = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : globalThis.fetch;
  const res = await fetchFn(input, {
    credentials: 'include',
    ...init,
  });
  return res;
}

async function safeJson<T = any>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    if (text.startsWith('<!doctype') || text.startsWith('<html')) {
      throw new Error(`Server returned HTML instead of JSON (${res.status} ${res.statusText})`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response: ${text.slice(0, 150)}`);
    }
  }
  return res.json();
}

export const api = {
  // System Health
  async getSystemStatus(): Promise<SystemStatus> {
    const res = await safeFetch('/api/system/status', {
      headers: getAuthHeaders(false),
    });
    if (!res.ok) throw new Error('Failed to fetch system status');
    return safeJson(res);
  },

  // Owner Auth
  async loginOwner(passcode: string): Promise<{ success: boolean; token: string }> {
    const res = await safeFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Login failed');
    setStoredToken(data.token);
    return data;
  },

  async logoutOwner(): Promise<void> {
    await safeFetch('/api/auth/logout', {
      method: 'POST',
      headers: getAuthHeaders(false),
    }).catch(() => {});
    clearStoredToken();
  },

  async checkAuth(): Promise<boolean> {
    try {
      const res = await safeFetch('/api/auth/check', {
        headers: getAuthHeaders(false),
      });
      const data = await safeJson(res);
      return Boolean(data.authenticated);
    } catch {
      return false;
    }
  },

  async changePasscode(oldPasscode: string, newPasscode: string): Promise<void> {
    const res = await safeFetch('/api/auth/passcode', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ oldPasscode, newPasscode }),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to update passcode');
  },

  // Videos List & Management
  async getVideos(): Promise<VideoMetadata[]> {
    const res = await safeFetch('/api/videos', {
      headers: getAuthHeaders(false),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to fetch videos');
    return data.videos || [];
  },

  async getVideo(id: string): Promise<VideoMetadata> {
    const res = await safeFetch(`/api/videos/item/${id}`, {
      headers: getAuthHeaders(false),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Video not found');
    return data.video;
  },

  async deleteVideo(id: string): Promise<void> {
    const res = await safeFetch(`/api/videos/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(false),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to delete video');
  },

  // Video Upload
  async uploadVideo(file: File): Promise<{ video: VideoMetadata; thumbnailUrl: string }> {
    const formData = new FormData();
    formData.append('video', file);

    const res = await safeFetch('/api/videos/upload', {
      method: 'POST',
      headers: getAuthHeaders(false),
      body: formData,
    });

    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to upload video');
    return data;
  },

  // Load Demonstration Sample Video
  async loadSampleVideo(sampleType: 'podcast' | 'educational' | 'technical_glitch' | 'keynote' | 'gaming' = 'podcast'): Promise<{
    video: VideoMetadata;
    thumbnailUrl: string;
  }> {
    const res = await safeFetch('/api/videos/sample', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ sampleType }),
    });

    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to load sample video');
    return data;
  },

  // AI Clip Analysis (Nemotron / Gemini)
  async analyzeVideo(params: {
    videoId: string;
    preferredProvider?: AiProviderMode;
    clipCount?: number;
    clipStyle?: EditorialCurationStyle;
    editorialStyle?: EditorialCurationStyle;
    customPrompt?: string;
    creatorDirection?: string;
    transcript?: string;
    videoCategory?: string;
    targetAudience?: string;
    targetPlatforms?: string[];
    chunkName?: string;
    chunkOffsetSeconds?: number;
    previouslySelectedClips?: ClipSuggestion[];
    privacyConsent?: boolean;
  }): Promise<{
    clips: ClipSuggestion[];
    sourceVideo: VideoMetadata;
    providerUsed?: 'nemotron' | 'gemini';
    modelUsed?: string;
    fallbackUsed?: boolean;
    fallbackReason?: string;
    openRouterDetails?: OpenRouterDetails;
    rejectedMoments?: Array<{ title?: string; start: number; end: number; reason: string }>;
    editorialStyleUsed?: EditorialCurationStyle;
    editorialPolicy?: {
      label: string;
      minDuration: number;
      maxDuration: number;
      idealRange: string;
    };
    creatorDirectionUsed?: string;
    stagesCompleted?: string[];
    hasInsufficientContent?: boolean;
    analysisSummary?: string;
    transcriptVerification?: TranscriptVerificationInfo;
    audit?: AnalysisAuditReport;
  }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('AI analysis client request timed out after 295s')), 295000);
    try {
      const res = await safeFetch('/api/ai/analyze', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      const data = await safeJson(res);
      if (!res.ok) {
        const err = new Error(data.error || 'AI analysis failed') as Error & {
          statusCode?: number;
          quotaExhausted?: boolean;
          resetAt?: string;
        };
        err.statusCode = res.status;
        if (data.quotaExhausted !== undefined) err.quotaExhausted = Boolean(data.quotaExhausted);
        if (data.resetAt) err.resetAt = String(data.resetAt);
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  // Delete Render Job and File
  async deleteRenderJob(jobId: string): Promise<void> {
    const res = await safeFetch(`/api/clips/render/${jobId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(false),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to delete render');
  },

  // List persisted & active render jobs
  async getRenderJobs(): Promise<RenderJob[]> {
    const res = await safeFetch('/api/clips/jobs', {
      headers: getAuthHeaders(false),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to load render jobs');
    return data.jobs || [];
  },

  // Authenticated, integrity-checked local MP4 download
  async downloadRenderedClip(
    job: Pick<RenderJob, 'id' | 'title' | 'downloadUrl' | 'outputFilename' | 'aspectRatio'>,
    onProgress?: (progress: { receivedBytes: number; totalBytes?: number; percent: number }) => void
  ): Promise<{ filename: string; bytes: number }> {
    const url = job.downloadUrl || `/api/clips/download/${job.id}`;
    const res = await safeFetch(url, {
      method: 'GET',
      headers: getAuthHeaders(false),
    });

    if (!res.ok) {
      let errMsg = `Download failed (HTTP ${res.status})`;
      try {
        const errData = await safeJson(res);
        if (errData?.error) errMsg = errData.error;
      } catch {}
      throw new Error(errMsg);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('video/mp4') && !contentType.includes('application/octet-stream')) {
      throw new Error(`Unexpected response type "${contentType || 'unknown'}" instead of MP4`);
    }

    const totalLenHeader = res.headers.get('content-length');
    const totalBytes = totalLenHeader ? parseInt(totalLenHeader, 10) : undefined;

    // Parse suggested filename from Content-Disposition or build safe fallback
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";\n]+)"?/i);
    const safeFallback = `${(job.title || 'clip').replace(/[^a-zA-Z0-9_-]/g, '_')}_${(job.aspectRatio || '9:16').replace(':', 'x')}.mp4`;
    const filename = match?.[1] ? decodeURIComponent(match[1].replace(/"/g, '').trim()) : job.outputFilename || safeFallback;

    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(value);
          receivedBytes += value.byteLength;
          const percent = totalBytes && totalBytes > 0 ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100)) : 50;
          onProgress?.({ receivedBytes, totalBytes, percent });
        }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      receivedBytes = buf.byteLength;
      onProgress?.({ receivedBytes, totalBytes, percent: 99 });
    }

    if (receivedBytes === 0) {
      throw new Error('Downloaded MP4 stream was empty (0 bytes received).');
    }

    if (totalBytes && !isNaN(totalBytes) && totalBytes > 0 && receivedBytes !== totalBytes) {
      throw new Error(
        `Incomplete MP4 transfer: received ${receivedBytes} of ${totalBytes} expected bytes.`
      );
    }

    onProgress?.({ receivedBytes, totalBytes, percent: 100 });

    const blobParts = chunks.map((c) => c.slice().buffer);
    const blob = new Blob(blobParts, { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      window.setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 15000);
    }

    return { filename, bytes: receivedBytes };
  },

  // FFmpeg Clip Rendering
  async renderClip(params: {
    sourceVideoId: string;
    clipId: string;
    title: string;
    startTime: number;
    endTime: number;
    aspectRatio: '9:16' | '1:1' | '16:9';
  }): Promise<RenderJob> {
    const res = await safeFetch('/api/clips/render', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(params),
    });

    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to start render');
    return data.job;
  },

  // Batch rendering for multiple clips atomically
  async batchRenderClips(params: {
    clips: Array<{
      clipId: string;
      sourceVideoId: string;
      title: string;
      startTime: number;
      endTime: number;
      aspectRatio?: '9:16' | '1:1' | '16:9';
    }>;
    defaultAspectRatio?: '9:16' | '1:1' | '16:9';
  }): Promise<{ success: boolean; count: number; jobs: RenderJob[] }> {
    const res = await safeFetch('/api/clips/batch-render', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(params),
    });

    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to dispatch batch render');
    return data;
  },

  // Retry a failed render job
  async retryRenderJob(jobId: string): Promise<{ success: boolean; job: RenderJob }> {
    const res = await safeFetch(`/api/clips/retry/${jobId}`, {
      method: 'POST',
      headers: getAuthHeaders(false),
    });

    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to retry render job');
    return data;
  },

  // Check Video Quality Report (Inspector)
  async inspectVideoQuality(videoId: string): Promise<{
    success: boolean;
    report: {
      videoId: string;
      duration: number;
      hasAudio: boolean;
      validContentRanges: Array<{ start: number; end: number }>;
      smpteBarsRanges: Array<{ start: number; end: number }>;
      blackScreenRanges: Array<{ start: number; end: number }>;
      technicalInterruptionRanges: Array<{ start: number; end: number; type: string; reason: string }>;
      overallQualityScore: number;
      recommendations: string[];
    };
  }> {
    const res = await safeFetch(`/api/quality/inspect/${videoId}`, {
      headers: getAuthHeaders(false),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to inspect video quality');
    return data;
  },

  // Check Render Job Status
  async getRenderJobStatus(jobId: string): Promise<RenderJob> {
    const res = await safeFetch(`/api/clips/status/${jobId}`, {
      headers: getAuthHeaders(false),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Job not found');
    return data.job;
  },

  // Projects & Supabase
  async getProjects(): Promise<ProjectData[]> {
    const res = await safeFetch('/api/projects', {
      headers: getAuthHeaders(false),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to load projects');
    return data.projects || [];
  },

  async saveProject(project: ProjectData): Promise<ProjectData> {
    const res = await safeFetch('/api/projects', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(project),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to save project');
    return data.project;
  },

  async getDatabaseStatus(): Promise<{
    isConfigured: boolean;
    url: string;
    hasServiceKey: boolean;
    schemaSql: string;
  }> {
    const res = await safeFetch('/api/database/status');
    return safeJson(res);
  },

  // Resource Management & Storage
  async getSystemResources(): Promise<import('../types/index.ts').SystemResourceInfo> {
    const res = await safeFetch('/api/system/resources');
    if (!res.ok) throw new Error('Failed to fetch system resources');
    return safeJson(res);
  },

  async getStorageInfo(): Promise<import('../types/index.ts').StorageArchitectureInfo> {
    const res = await safeFetch('/api/storage/info');
    if (!res.ok) throw new Error('Failed to fetch storage info');
    return safeJson(res);
  },

  async getUploadStatus(uploadId: string): Promise<import('../types/index.ts').ResumableUploadSession> {
    const res = await safeFetch(`/api/upload/status/${uploadId}`, {
      headers: getAuthHeaders(false),
    });
    if (!res.ok) throw new Error('Failed to fetch upload status');
    return safeJson(res);
  },

  async cancelUpload(uploadId: string): Promise<void> {
    await safeFetch(`/api/upload/cancel/${uploadId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(false),
    });
  },

  // Validation Check
  async validateClip(params: {
    clip: Partial<ClipSuggestion>;
    videoDuration: number;
    transcript?: string;
  }): Promise<{ isValid: boolean; errors: string[] }> {
    const res = await safeFetch('/api/clips/validate', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error('Validation check failed');
    return safeJson(res);
  },

  // Individual Clip Publishing
  async publishClip(payload: {
    clipId: string;
    projectId?: string;
    title: string;
    hook: string;
    platform: 'tiktok' | 'reels' | 'shorts' | 'facebook' | 'all';
    postCaption?: string;
    hashtags?: string[];
    videoUrl?: string;
    downloadUrl?: string;
    renderJobId?: string;
    scheduledFor?: string;
  }): Promise<{ success: boolean; publishedClip: PublishedClip; message: string }> {
    const res = await safeFetch('/api/clips/publish', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Publishing failed');
    return data;
  },

  async getPublishedClips(): Promise<PublishedClip[]> {
    const res = await safeFetch('/api/clips/published', {
      headers: getAuthHeaders(false),
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || 'Failed to fetch published clips');
    return data.published || [];
  },

  async deletePublishedClip(id: string): Promise<void> {
    const res = await safeFetch(`/api/clips/publish/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(false),
    });
    if (!res.ok) throw new Error('Failed to unpublish clip');
  },

  // Client-side Supabase instance (configured with non-mutating native fetch wrapper)
  getClientSupabase() {
    return getSupabaseClient();
  },
};


