export interface VideoMetadata {
  id: string;
  filename: string;
  originalName: string;
  filepath: string;
  url: string;
  duration: number; // in seconds
  width: number;
  height: number;
  aspectRatio: string;
  format: string;
  size: number; // bytes
  bitrate?: number;
  fps?: number;
  hasAudio: boolean;
  uploadedAt: string;
}

export interface ClipSuggestion {
  id: string;
  title: string;
  hook: string;
  description: string;
  startTime: number; // seconds
  endTime: number; // seconds
  duration: number; // seconds
  viralityScore: number; // 1-100
  viralityReason: string;
  targetPlatform: 'tiktok' | 'reels' | 'shorts' | 'all';
  suggestedAspectRatio: '9:16' | '1:1' | '16:9';
  captions?: string;
  hashtags: string[];
  keyQuotes?: string[];
}

export interface RenderJob {
  id: string;
  clipId: string;
  title: string;
  sourceVideoId: string;
  startTime: number;
  endTime: number;
  aspectRatio: '9:16' | '1:1' | '16:9';
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  progress: number; // 0 - 100
  outputFilename?: string;
  outputPath?: string;
  downloadUrl?: string;
  fileSize?: number;
  duration?: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ProjectData {
  id: string;
  title: string;
  sourceVideo?: VideoMetadata;
  clips: ClipSuggestion[];
  renderJobs: RenderJob[];
  createdAt: string;
  updatedAt: string;
}

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  isConfigured: boolean;
}

export interface SystemStatus {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegVersion?: string;
  geminiConfigured: boolean;
  supabaseConnected: boolean;
  authenticated: boolean;
  activeUploadsCount: number;
}

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

export interface StorageProviderLimit {
  provider: 'local_scratch' | 'supabase_storage' | 's3_compatible';
  name: string;
  maxFileSize: string;
  maxFileSizeBytes: number;
  resumableSupported: boolean;
  notes: string;
}

export interface StorageArchitectureInfo {
  activeProvider: 'local_scratch' | 'supabase_storage' | 's3_compatible';
  s3: { isConfigured: boolean; bucket?: string; endpoint?: string };
  supabaseStorage: { isConfigured: boolean; maxFileSizeNotice: string };
  limits: StorageProviderLimit[];
}

export interface ResumableUploadSession {
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
}

export interface ClientUploadProgress {
  uploadId: string;
  filename: string;
  totalSize: number;
  uploadedBytes: number;
  percent: number;
  chunkIndex: number;
  totalChunks: number;
  speedBytesPerSec: number;
  etaSeconds: number;
  status: 'idle' | 'uploading' | 'paused' | 'assembling' | 'probing' | 'completed' | 'error';
  error?: string;
}

