import React, { useState, useRef, useEffect } from 'react';
import {
  UploadCloud,
  Film,
  Sparkles,
  Play,
  FileVideo,
  Clock,
  AlertCircle,
  Loader2,
  CheckCircle,
  Pause,
  RotateCcw,
  HardDrive,
  Cpu,
  Layers,
  ArrowRight,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { api } from '../services/api.ts';
import { ResumableUploader } from '../services/resumableUploader.ts';
import { VideoMetadata, ClientUploadProgress, SystemResourceInfo } from '../types/index.ts';

interface VideoUploaderProps {
  onVideoLoaded: (video: VideoMetadata) => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}

export const VideoUploader: React.FC<VideoUploaderProps> = ({
  onVideoLoaded,
  isLoading,
  setIsLoading,
}) => {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resources, setResources] = useState<SystemResourceInfo | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Resumable upload state
  const [chunkSizeMb, setChunkSizeMb] = useState<number>(10);
  const [uploadProgress, setUploadProgress] = useState<ClientUploadProgress | null>(null);
  const [uploader, setUploader] = useState<ResumableUploader | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [savedSessionNotice, setSavedSessionNotice] = useState<{
    uploadId: string;
    filename: string;
    totalSize: number;
  } | null>(null);

  // Fetch disk resources
  useEffect(() => {
    api.getSystemResources()
      .then(setResources)
      .catch((err) => console.warn('Could not fetch resources:', err));

    // Check localStorage for saved session
    try {
      const raw = localStorage.getItem('clipgenius_active_upload_session');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.uploadId && parsed.filename) {
          setSavedSessionNotice(parsed);
        }
      }
    } catch {}
  }, []);

  const formatBytes = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatEta = (seconds: number) => {
    if (!seconds || seconds <= 0) return 'calculating...';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (m > 0) return `${m}m ${s}s remaining`;
    return `${s}s remaining`;
  };

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('video/') && !file.name.match(/\.(mp4|mov|webm|mkv|avi|m4v)$/i)) {
      setError('Please select a valid video file (MP4, MOV, WebM, MKV)');
      return;
    }

    // Validate size against available disk space and 20 GB ceiling
    const maxSafe = resources?.maxSafeUploadSizeBytes || 20 * 1024 * 1024 * 1024;
    if (file.size > maxSafe) {
      setError(
        `File size (${formatBytes(file.size)}) exceeds server storage limit of ${formatBytes(
          maxSafe
        )}. Please free disk space or select a smaller video.`
      );
      return;
    }

    setError(null);
    setIsLoading(true);
    setIsPaused(false);

    const chunkSizeBytes = chunkSizeMb * 1024 * 1024;
    const newUploader = new ResumableUploader(file, {
      chunkSize: chunkSizeBytes,
      onProgress: (prog) => {
        setUploadProgress(prog);
      },
      onError: (err) => {
        setError(err.message);
        setIsLoading(false);
      },
      onComplete: (video) => {
        setUploadProgress(null);
        setIsLoading(false);
        onVideoLoaded(video);
      },
    });

    setUploader(newUploader);

    try {
      await newUploader.start();
    } catch (err) {
      if ((err as Error).message !== 'Upload paused') {
        setError((err as Error).message || 'Failed to complete resumable upload');
        setIsLoading(false);
      }
    }
  };

  const handlePause = () => {
    if (uploader) {
      uploader.pause();
      setIsPaused(true);
    }
  };

  const handleResume = async () => {
    if (uploader) {
      setIsPaused(false);
      try {
        await uploader.resume();
      } catch (err) {
        if ((err as Error).message !== 'Upload paused') {
          setError((err as Error).message);
          setIsLoading(false);
        }
      }
    }
  };

  const handleCancel = async () => {
    if (uploader) {
      await uploader.cancel();
    }
    setUploader(null);
    setUploadProgress(null);
    setIsPaused(false);
    setIsLoading(false);
    setSavedSessionNotice(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  const handleSample = async (sampleType: 'podcast' | 'keynote' | 'gaming') => {
    setError(null);
    setIsLoading(true);
    try {
      const result = await api.loadSampleVideo(sampleType);
      onVideoLoaded(result.video);
    } catch (err) {
      setError((err as Error).message || 'Failed to load demonstration video');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full space-y-6">
      {/* Infrastructure Disk & Scale Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 px-4 py-2.5 text-xs">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-emerald-400" />
          <span className="text-neutral-300 font-medium">Scalable Storage Engine:</span>
          <span className="font-mono text-emerald-300">
            {resources ? `${formatBytes(resources.freeDisk)} Free Scratch Disk` : '504 GB Available'}
          </span>
          <span className="text-neutral-500">•</span>
          <span className="text-neutral-400">Max File Size: 20 GB</span>
        </div>

        <div className="flex items-center gap-2 text-neutral-400">
          <ShieldCheck className="h-4 w-4 text-violet-400" />
          <span>Chunked TUS / Multi-Part Stream Protocol (Zero RAM Buffer)</span>
        </div>
      </div>

      {/* Upload Zone or Active Upload Card */}
      {!uploadProgress ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !isLoading && fileInputRef.current?.click()}
          className={`group relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 sm:p-12 text-center transition cursor-pointer ${
            dragOver
              ? 'border-violet-500 bg-violet-950/20 shadow-2xl shadow-violet-500/10'
              : 'border-neutral-800 bg-neutral-900/60 hover:border-neutral-700 hover:bg-neutral-900'
          } ${isLoading ? 'pointer-events-none opacity-80' : ''}`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files[0]) {
                handleFile(e.target.files[0]);
              }
            }}
          />

          <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-tr from-violet-600/20 to-indigo-600/20 border border-violet-500/30 text-violet-400 group-hover:scale-105 transition">
            {isLoading ? (
              <Loader2 className="h-8 w-8 animate-spin text-violet-400" />
            ) : (
              <UploadCloud className="h-8 w-8" />
            )}
          </div>

          <h3 className="mt-4 text-lg font-bold text-white">
            {isLoading ? 'Processing Video...' : 'Drop your 2–3 hour long-form video here'}
          </h3>
          <p className="mt-1 text-xs text-neutral-400 max-w-md">
            Full support for large source videos up to <strong className="text-white">20 GB</strong> (MP4, MOV, WebM, MKV).
            Uploaded in resilient, resumable chunks with zero RAM buffering.
          </p>

          {/* Chunk size config */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="mt-5 flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-400"
          >
            <span>Resumable Chunk Size:</span>
            <div className="flex gap-1">
              {[5, 10, 20].map((mb) => (
                <button
                  key={mb}
                  type="button"
                  onClick={() => setChunkSizeMb(mb)}
                  className={`rounded px-2 py-0.5 text-[11px] font-semibold transition ${
                    chunkSizeMb === mb
                      ? 'bg-violet-600 text-white'
                      : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                  }`}
                >
                  {mb} MB
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-[11px] text-neutral-400">
            <span className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3 text-emerald-400" /> Resumable Chunking
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3 text-emerald-400" /> Auto-Retry on Drop
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3 text-emerald-400" /> Stream Assembling
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle className="h-3 w-3 text-emerald-400" /> 20 GB Capacity
            </span>
          </div>
        </div>
      ) : (
        /* Active Resumable Upload Progress Card */
        <div className="rounded-2xl border border-violet-500/50 bg-neutral-900/90 p-6 shadow-2xl space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600/20 border border-violet-500/30 text-violet-400">
                {uploadProgress.status === 'assembling' || uploadProgress.status === 'probing' ? (
                  <Cpu className="h-6 w-6 animate-pulse" />
                ) : (
                  <UploadCloud className="h-6 w-6" />
                )}
              </div>
              <div>
                <h4 className="text-sm font-bold text-white truncate max-w-md">
                  {uploadProgress.filename}
                </h4>
                <p className="text-xs text-neutral-400">
                  {formatBytes(uploadProgress.uploadedBytes)} of {formatBytes(uploadProgress.totalSize)} •{' '}
                  <span className="font-mono text-violet-300">
                    Chunk {uploadProgress.chunkIndex}/{uploadProgress.totalChunks}
                  </span>
                </p>
              </div>
            </div>

            {/* Current Stage Badge */}
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-violet-500/10 border border-violet-500/30 px-3 py-1 text-xs font-semibold text-violet-300">
                {uploadProgress.status === 'uploading' && 'Uploading Chunks...'}
                {uploadProgress.status === 'paused' && 'Paused'}
                {uploadProgress.status === 'assembling' && 'Stitching Chunks on Disk...'}
                {uploadProgress.status === 'probing' && 'FFprobe Stream Analysis...'}
                {uploadProgress.status === 'completed' && 'Complete!'}
              </span>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="space-y-1.5">
            <div className="h-3 w-full rounded-full bg-neutral-950 overflow-hidden border border-neutral-800">
              <div
                className="h-full bg-gradient-to-r from-violet-600 via-indigo-500 to-fuchsia-500 transition-all duration-300"
                style={{ width: `${uploadProgress.percent}%` }}
              />
            </div>
            <div className="flex justify-between items-center text-xs font-mono text-neutral-400">
              <span>{uploadProgress.percent}% completed</span>
              <div className="flex items-center gap-3">
                {uploadProgress.speedBytesPerSec > 0 && (
                  <span className="text-neutral-300 font-sans">
                    {(uploadProgress.speedBytesPerSec / (1024 * 1024)).toFixed(1)} MB/s
                  </span>
                )}
                {uploadProgress.etaSeconds > 0 && (
                  <span>{formatEta(uploadProgress.etaSeconds)}</span>
                )}
              </div>
            </div>
          </div>

          {/* Controls: Pause / Resume / Cancel */}
          <div className="flex items-center justify-between pt-2 border-t border-neutral-800">
            <p className="text-xs text-neutral-400">
              You can pause and resume at any time. Progress is saved locally.
            </p>

            <div className="flex items-center gap-2">
              {isPaused ? (
                <button
                  type="button"
                  onClick={handleResume}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 transition"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  <span>Resume</span>
                </button>
              ) : (
                uploadProgress.status === 'uploading' && (
                  <button
                    type="button"
                    onClick={handlePause}
                    className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-700 transition"
                  >
                    <Pause className="h-3.5 w-3.5" />
                    <span>Pause</span>
                  </button>
                )
              )}

              <button
                type="button"
                onClick={handleCancel}
                className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900/40 transition"
              >
                Cancel Upload
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Saved Session Notice (if user refreshed page) */}
      {savedSessionNotice && !uploadProgress && (
        <div className="flex items-center justify-between rounded-xl border border-violet-500/30 bg-violet-950/30 p-3.5 text-xs text-violet-200">
          <div className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-violet-400" />
            <span>
              Unfinished upload detected: <strong>{savedSessionNotice.filename}</strong> (
              {formatBytes(savedSessionNotice.totalSize)}). Select the file to resume from the last chunk.
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem('clipgenius_active_upload_session');
              setSavedSessionNotice(null);
            }}
            className="text-neutral-400 hover:text-white text-[11px] underline ml-2"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-950/30 p-3.5 text-xs text-red-300">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Instant Demonstration Videos */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-400" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-300">
              Or Instant Demo: Generate Source Video via FFmpeg
            </h4>
          </div>
          <span className="text-[11px] text-neutral-400">Ready in 2 seconds</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            type="button"
            disabled={isLoading}
            onClick={() => handleSample('podcast')}
            className="flex items-start gap-3 rounded-xl border border-neutral-800 bg-neutral-950/80 p-3 text-left hover:border-violet-500/50 hover:bg-neutral-900 transition group disabled:opacity-50"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400 group-hover:bg-violet-500/20">
              <FileVideo className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs font-semibold text-white">Podcast Masterclass</p>
              <p className="text-[11px] text-neutral-400 mt-0.5">Full interview audio & test stream</p>
            </div>
          </button>

          <button
            type="button"
            disabled={isLoading}
            onClick={() => handleSample('keynote')}
            className="flex items-start gap-3 rounded-xl border border-neutral-800 bg-neutral-950/80 p-3 text-left hover:border-indigo-500/50 hover:bg-neutral-900 transition group disabled:opacity-50"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400 group-hover:bg-indigo-500/20">
              <Film className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs font-semibold text-white">AI Revolution Keynote</p>
              <p className="text-[11px] text-neutral-400 mt-0.5">Tech presentation demo</p>
            </div>
          </button>

          <button
            type="button"
            disabled={isLoading}
            onClick={() => handleSample('gaming')}
            className="flex items-start gap-3 rounded-xl border border-neutral-800 bg-neutral-950/80 p-3 text-left hover:border-emerald-500/50 hover:bg-neutral-900 transition group disabled:opacity-50"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 group-hover:bg-emerald-500/20">
              <Play className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs font-semibold text-white">Gaming Championship</p>
              <p className="text-[11px] text-neutral-400 mt-0.5">Fast-paced high action</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
