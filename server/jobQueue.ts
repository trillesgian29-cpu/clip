import fs from 'fs';
import os from 'os';

export interface SystemResourceInfo {
  totalDisk: number;
  freeDisk: number;
  usedDisk: number;
  diskPercentUsed: number;
  totalMemory: number;
  freeMemory: number;
  memoryPercentUsed: number;
  cpuCount: number;
  activeJobsCount: number;
  maxConcurrentJobs: number;
  maxSafeUploadSizeBytes: number;
}

export interface BackgroundJob<T = any> {
  id: string;
  type: 'render' | 'probe' | 'cleanup';
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: T;
  task: () => Promise<T>;
}

// Global queue manager
const MAX_CONCURRENT_JOBS = 2;
const activeJobs = new Map<string, BackgroundJob>();
const queue: BackgroundJob[] = [];

/**
 * Checks available disk space on the hosting environment
 */
export async function checkAvailableDiskSpace(): Promise<{
  total: number;
  free: number;
  used: number;
}> {
  try {
    const stats = await fs.promises.statfs('/');
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = total - free;
    return { total, free, used };
  } catch (error) {
    console.error('Failed to get disk stats:', error);
    // Safe fallback estimate
    return {
      total: 500 * 1024 * 1024 * 1024,
      free: 450 * 1024 * 1024 * 1024,
      used: 50 * 1024 * 1024 * 1024,
    };
  }
}

/**
 * Reads memory and system stats
 */
export async function getSystemResourceInfo(): Promise<SystemResourceInfo> {
  const disk = await checkAvailableDiskSpace();

  // RAM from os module
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const memoryPercentUsed = Math.round(((totalMemory - freeMemory) / totalMemory) * 100);

  const diskPercentUsed = Math.round((disk.used / disk.total) * 100);
  const cpuCount = os.cpus().length || 2;

  // Max safe single upload size: 20 GB or available free disk minus 5 GB reserve
  const maxSafeUploadSizeBytes = Math.min(
    20 * 1024 * 1024 * 1024,
    Math.max(0, disk.free - 5 * 1024 * 1024 * 1024)
  );

  return {
    totalDisk: disk.total,
    freeDisk: disk.free,
    usedDisk: disk.used,
    diskPercentUsed,
    totalMemory,
    freeMemory,
    memoryPercentUsed,
    cpuCount,
    activeJobsCount: activeJobs.size,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    maxSafeUploadSizeBytes,
  };
}

/**
 * Enqueues a heavy background task (e.g., FFmpeg render) with concurrency control
 */
export function enqueueJob<T>(job: BackgroundJob<T>): void {
  queue.push(job);
  processNext();
}

async function processNext(): Promise<void> {
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    return;
  }

  const nextJob = queue.shift();
  if (!nextJob) {
    return;
  }

  activeJobs.set(nextJob.id, nextJob);
  nextJob.status = 'running';
  nextJob.startedAt = Date.now();

  try {
    const result = await nextJob.task();
    nextJob.status = 'completed';
    nextJob.completedAt = Date.now();
    nextJob.result = result;
    nextJob.progress = 100;
  } catch (err) {
    console.error(`Job ${nextJob.id} failed:`, err);
    nextJob.status = 'failed';
    nextJob.error = (err as Error).message;
  } finally {
    activeJobs.delete(nextJob.id);
    // Trigger next queued job
    processNext();
  }
}

export function getJobStatus(jobId: string): BackgroundJob | undefined {
  return activeJobs.get(jobId) || queue.find((j) => j.id === jobId);
}
