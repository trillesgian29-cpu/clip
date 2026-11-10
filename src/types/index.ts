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

export interface ViralScores {
  hook: number;
  standalone: number;
  emotion: number;
  payoff: number;
  share_worthy: number;
  pacing: number;
  visual_potential: number;
  overall_average: number;
}

export interface StoryStructure {
  opening: string;
  context: string;
  curiosity: string;
  payoff: string;
}

export interface ClipSuggestion {
  id: string;
  title: string;
  hook: string;
  description: string;
  startTime: number; // seconds (global)
  endTime: number; // seconds (global)
  duration: number; // seconds
  viralityScore: number; // 1-100 (for backward compatibility)
  viralityReason: string;
  targetPlatform: 'tiktok' | 'reels' | 'shorts' | 'all';
  suggestedAspectRatio: '9:16' | '1:1' | '16:9';
  captions?: string;
  hashtags: string[];
  keyQuotes?: string[];
  // Evidence-based Selection & Nemotron fields
  clipId?: string;
  sourceVideoId?: string;
  start?: number;
  end?: number;
  score?: number;
  confidence?: number;
  category?: string;
  analysisStatus?: 'completed' | 'pending' | 'failed';
  thumbnailUrl?: string;
  selected?: boolean;
  // Viral Detection & Review Fields
  clip_id?: string;
  local_start?: string;
  local_end?: string;
  global_start_seconds?: number;
  global_end_seconds?: number;
  duration_seconds?: number;
  exact_quote?: string;
  reason?: string;
  scores?: ViralScores;
  weakness?: string;
  alternate_hooks?: string[];
  story_structure?: StoryStructure;
  selection_status?: 'qualified' | 'rejected';
  reviewStatus?: 'needs_review' | 'approved' | 'rejected';
  publishStatus?: 'draft' | 'ready_to_publish' | 'published';
  publishedAt?: string;
  publishedPlatform?: 'tiktok' | 'reels' | 'shorts' | 'facebook' | 'all';
  publishedId?: string;
}

export interface PublishedClip {
  id: string;
  clipId: string;
  projectId?: string;
  title: string;
  hook: string;
  platform: 'tiktok' | 'reels' | 'shorts' | 'facebook' | 'all';
  postCaption: string;
  hashtags: string[];
  videoUrl?: string;
  downloadUrl?: string;
  renderJobId?: string;
  publishedAt: string;
  status: 'published' | 'scheduled';
  scheduledFor?: string;
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
  openRouterConfigured: boolean;
  openRouterModel?: string;
  activeAiProvider: 'nemotron' | 'gemini' | 'none';
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

