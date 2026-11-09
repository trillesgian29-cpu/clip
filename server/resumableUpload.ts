import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { checkAvailableDiskSpace } from './jobQueue.ts';

export interface UploadSession {
  uploadId: string;
  filename: string;
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  receivedBytes: number;
  status: 'active' | 'assembling' | 'completed' | 'cancelled' | 'failed';
  error?: string;
  createdAt: number;
  updatedAt: number;
  finalPath: string;
  chunkDir: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'upload_sessions.json');
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
const CHUNKS_BASE_DIR = path.resolve(process.cwd(), 'uploads', 'chunks');

// Ensure directories exist
[DATA_DIR, UPLOADS_DIR, CHUNKS_BASE_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Max file size supported by current infrastructure (up to 20 GB, or disk capacity minus 5 GB safety reserve)
export const ABSOLUTE_MAX_FILE_SIZE = 20 * 1024 * 1024 * 1024; // 20 GB

// In-memory sessions map backed by persistent JSON file
const sessions = new Map<string, UploadSession>();

function loadSessions(): void {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      for (const s of data) {
        sessions.set(s.uploadId, s);
      }
    }
  } catch (err) {
    console.warn('Could not load upload sessions from file:', err);
  }
}

function saveSessions(): void {
  try {
    const list = Array.from(sessions.values()).map((s) => ({
      ...s,
    }));
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Could not save upload sessions to file:', err);
  }
}

loadSessions();

/**
 * Initializes a new resumable upload session
 */
export async function initUploadSession(params: {
  filename: string;
  totalSize: number;
  chunkSize?: number;
  mimeType?: string;
}): Promise<{ session: UploadSession; maxSupportedSize: number; freeSpaceBytes: number }> {
  const { filename, totalSize, chunkSize = 10 * 1024 * 1024 } = params;

  // Check disk capacity
  const disk = await checkAvailableDiskSpace();
  const maxSafeSize = Math.min(ABSOLUTE_MAX_FILE_SIZE, Math.max(0, disk.free - 5 * 1024 * 1024 * 1024));

  if (totalSize > ABSOLUTE_MAX_FILE_SIZE) {
    throw new Error(
      `Requested file size (${(totalSize / (1024 ** 3)).toFixed(2)} GB) exceeds application maximum limit of 20 GB.`
    );
  }

  // Need at least totalSize + 2GB safety reserve for chunks + assembled file
  if (totalSize + 2 * 1024 * 1024 * 1024 > disk.free) {
    throw new Error(
      `Insufficient server disk space. Required: ${(totalSize / (1024 ** 3)).toFixed(2)} GB. Available: ${(
        disk.free / (1024 ** 3)
      ).toFixed(2)} GB.`
    );
  }

  const uploadId = `upl-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const ext = path.extname(filename).toLowerCase() || '.mp4';
  const cleanBase = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const finalFilename = `video-${uploadId}-${cleanBase}${ext}`;
  const finalPath = path.join(UPLOADS_DIR, finalFilename);
  const chunkDir = path.join(CHUNKS_BASE_DIR, uploadId);

  if (!fs.existsSync(chunkDir)) {
    fs.mkdirSync(chunkDir, { recursive: true });
  }

  const totalChunks = Math.ceil(totalSize / chunkSize);

  const session: UploadSession = {
    uploadId,
    filename,
    totalSize,
    chunkSize,
    totalChunks,
    receivedChunks: [],
    receivedBytes: 0,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finalPath,
    chunkDir,
  };

  sessions.set(uploadId, session);
  saveSessions();

  return {
    session,
    maxSupportedSize: maxSafeSize,
    freeSpaceBytes: disk.free,
  };
}

/**
 * Gets the current status of an upload session, including already received chunks
 */
export function getUploadSession(uploadId: string): UploadSession | undefined {
  return sessions.get(uploadId);
}

/**
 * Writes an incoming chunk directly to disk without loading it into RAM
 */
export async function saveChunk(params: {
  uploadId: string;
  chunkIndex: number;
  chunkStream: NodeJS.ReadableStream;
  expectedSize: number;
}): Promise<{
  receivedChunks: number[];
  receivedBytes: number;
  percent: number;
  isComplete: boolean;
}> {
  const { uploadId, chunkIndex, chunkStream, expectedSize } = params;
  const session = sessions.get(uploadId);

  if (!session) {
    throw new Error(`Upload session "${uploadId}" not found or expired.`);
  }

  if (session.status !== 'active') {
    throw new Error(`Upload session is currently ${session.status}.`);
  }

  if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
    throw new Error(`Invalid chunk index ${chunkIndex}. Total expected: ${session.totalChunks}`);
  }

  const chunkPath = path.join(session.chunkDir, `chunk_${chunkIndex}.part`);
  const writeStream = fs.createWriteStream(chunkPath);

  // Stream directly from HTTP request into file on disk
  await pipeline(chunkStream, writeStream);

  const writtenStat = await fs.promises.stat(chunkPath);
  if (expectedSize > 0 && writtenStat.size !== expectedSize) {
    // Clean bad chunk
    await fs.promises.unlink(chunkPath).catch(() => {});
    throw new Error(
      `Chunk size mismatch: expected ${expectedSize} bytes, but received ${writtenStat.size} bytes.`
    );
  }

  // Update session state
  if (!session.receivedChunks.includes(chunkIndex)) {
    session.receivedChunks.push(chunkIndex);
    session.receivedChunks.sort((a, b) => a - b);
  }

  // Recalculate actual received bytes across chunks
  let totalBytes = 0;
  for (const idx of session.receivedChunks) {
    const p = path.join(session.chunkDir, `chunk_${idx}.part`);
    if (fs.existsSync(p)) {
      totalBytes += fs.statSync(p).size;
    }
  }

  session.receivedBytes = totalBytes;
  session.updatedAt = Date.now();
  saveSessions();

  const isComplete = session.receivedChunks.length === session.totalChunks;
  const percent = Math.min(100, Math.round((session.receivedBytes / session.totalSize) * 100));

  return {
    receivedChunks: session.receivedChunks,
    receivedBytes: session.receivedBytes,
    percent,
    isComplete,
  };
}

/**
 * Assembles all chunks into the final video file via streaming
 * Zero memory buffering: reads chunk by chunk and pipes to output write stream
 */
export async function assembleUpload(uploadId: string): Promise<string> {
  const session = sessions.get(uploadId);
  if (!session) {
    throw new Error(`Upload session "${uploadId}" not found.`);
  }

  if (session.receivedChunks.length !== session.totalChunks) {
    throw new Error(
      `Cannot assemble upload: received ${session.receivedChunks.length} of ${session.totalChunks} chunks.`
    );
  }

  session.status = 'assembling';
  saveSessions();

  const outStream = fs.createWriteStream(session.finalPath);

  try {
    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(session.chunkDir, `chunk_${i}.part`);
      if (!fs.existsSync(chunkPath)) {
        throw new Error(`Missing chunk file at index ${i}`);
      }

      const chunkReadStream = fs.createReadStream(chunkPath);
      await new Promise<void>((resolve, reject) => {
        chunkReadStream.pipe(outStream, { end: false });
        chunkReadStream.on('end', () => resolve());
        chunkReadStream.on('error', (err) => reject(err));
      });

      // Remove chunk immediately after stitching to reclaim disk space progressively!
      await fs.promises.unlink(chunkPath).catch(() => {});
    }

    outStream.end();
    await new Promise<void>((resolve, reject) => {
      outStream.on('finish', () => resolve());
      outStream.on('error', (err) => reject(err));
    });

    // Remove empty chunk directory
    await fs.promises.rm(session.chunkDir, { recursive: true, force: true }).catch(() => {});

    const finalStat = await fs.promises.stat(session.finalPath);
    if (finalStat.size !== session.totalSize) {
      console.warn(
        `Final assembled file size (${finalStat.size}) differed slightly from metadata (${session.totalSize})`
      );
    }

    session.status = 'completed';
    session.receivedBytes = finalStat.size;
    session.updatedAt = Date.now();
    saveSessions();

    return session.finalPath;
  } catch (error) {
    session.status = 'failed';
    session.error = (error as Error).message;
    saveSessions();
    throw error;
  }
}

/**
 * Cancels an upload and removes all chunks from disk
 */
export async function cancelUpload(uploadId: string): Promise<void> {
  const session = sessions.get(uploadId);
  if (session) {
    session.status = 'cancelled';
    saveSessions();
    if (fs.existsSync(session.chunkDir)) {
      await fs.promises.rm(session.chunkDir, { recursive: true, force: true }).catch(() => {});
    }
    if (fs.existsSync(session.finalPath)) {
      await fs.promises.unlink(session.finalPath).catch(() => {});
    }
    sessions.delete(uploadId);
    saveSessions();
  }
}

/**
 * Periodic cleanup of stale sessions older than 24 hours
 */
export async function cleanupStaleUploads(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, session] of sessions.entries()) {
    if (now - session.updatedAt > maxAgeMs && session.status !== 'completed') {
      await cancelUpload(id);
      cleaned++;
    }
  }

  return cleaned;
}
