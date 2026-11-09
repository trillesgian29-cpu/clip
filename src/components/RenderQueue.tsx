import React from 'react';
import {
  Download,
  Play,
  Film,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Layers,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { RenderJob } from '../types/index.ts';

interface RenderQueueProps {
  jobs: RenderJob[];
  onClearJob?: (jobId: string) => void;
}

export const RenderQueue: React.FC<RenderQueueProps> = ({ jobs, onClearJob }) => {
  if (jobs.length === 0) {
    return (
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-8 text-center">
        <Film className="mx-auto h-10 w-10 text-neutral-600 mb-3" />
        <h4 className="text-sm font-semibold text-neutral-300">No Render Jobs in Queue</h4>
        <p className="mt-1 text-xs text-neutral-500 max-w-sm mx-auto">
          Select any AI-generated clip and click "Render MP4" to trigger real server-side FFmpeg rendering and download individual clips.
        </p>
      </div>
    );
  }

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-violet-400" />
          <h3 className="text-sm font-bold text-white">FFmpeg Rendered MP4 Clips</h3>
          <span className="rounded-full bg-violet-500/20 px-2 py-0.5 text-[11px] font-bold text-violet-300">
            {jobs.length} {jobs.length === 1 ? 'Clip' : 'Clips'}
          </span>
        </div>
        <span className="text-[11px] text-neutral-400">
          Native H.264 / AAC High-Quality MP4 Output
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {jobs.map((job) => {
          const isRendering = job.status === 'rendering' || job.status === 'queued';
          const isCompleted = job.status === 'completed';
          const isFailed = job.status === 'failed';

          return (
            <div
              key={job.id}
              className={`rounded-2xl border p-4 sm:p-5 flex flex-col justify-between transition ${
                isCompleted
                  ? 'border-emerald-500/40 bg-neutral-900/90 shadow-xl shadow-emerald-500/5'
                  : isRendering
                  ? 'border-violet-500/50 bg-neutral-900/80'
                  : 'border-red-500/40 bg-neutral-900/80'
              }`}
            >
              <div>
                {/* Title & Badge */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] font-bold text-neutral-300 border border-neutral-700">
                        {job.aspectRatio} Aspect
                      </span>
                      <span className="text-xs font-mono text-neutral-400">
                        {job.duration ? `${job.duration.toFixed(1)}s` : ''}
                      </span>
                    </div>
                    <h4 className="mt-1.5 text-sm font-bold text-white leading-snug">
                      {job.title}
                    </h4>
                  </div>

                  {/* Status Indicator */}
                  <div>
                    {isRendering && (
                      <div className="flex items-center gap-1.5 rounded-full bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-300 border border-violet-500/30">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Rendering ({job.progress}%)</span>
                      </div>
                    )}
                    {isCompleted && (
                      <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 border border-emerald-500/30">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                        <span>Rendered</span>
                      </div>
                    )}
                    {isFailed && (
                      <div className="flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300 border border-red-500/30">
                        <AlertCircle className="h-3.5 w-3.5 text-red-400" />
                        <span>Failed</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Real-time Progress Bar */}
                {isRendering && (
                  <div className="mt-4 space-y-1.5">
                    <div className="h-2 w-full rounded-full bg-neutral-800 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-300"
                        style={{ width: `${Math.max(5, job.progress)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] text-neutral-400">
                      <span>Encoding frames with FFmpeg...</span>
                      <span className="font-mono">{job.progress}%</span>
                    </div>
                  </div>
                )}

                {/* Error message */}
                {isFailed && job.error && (
                  <div className="mt-3 rounded-lg bg-red-950/40 border border-red-500/30 p-2.5 text-xs text-red-300">
                    {job.error}
                  </div>
                )}

                {/* Playable Video Preview for completed rendered clip */}
                {isCompleted && (
                  <div className="mt-4 overflow-hidden rounded-xl bg-black border border-neutral-800 relative group">
                    <video
                      src={`/api/clips/stream/${job.id}`}
                      controls
                      preload="metadata"
                      className="w-full max-h-56 object-contain mx-auto"
                    />
                  </div>
                )}
              </div>

              {/* Actions Footer */}
              <div className="mt-4 flex items-center justify-between pt-3 border-t border-neutral-800/80">
                <span className="text-xs font-mono text-neutral-400">
                  {job.fileSize ? formatFileSize(job.fileSize) : 'MP4 File'}
                </span>

                <div className="flex items-center gap-2">
                  {isCompleted && job.downloadUrl && (
                    <a
                      href={job.downloadUrl}
                      download={job.outputFilename || 'clip.mp4'}
                      className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2 text-xs font-bold text-white shadow-md shadow-emerald-600/20 hover:from-emerald-500 hover:to-teal-500 transition"
                    >
                      <Download className="h-4 w-4" />
                      <span>Download MP4</span>
                    </a>
                  )}

                  {onClearJob && (
                    <button
                      onClick={() => onClearJob(job.id)}
                      className="rounded-lg p-2 text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition"
                      title="Remove from queue"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
