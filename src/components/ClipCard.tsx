import React, { useState } from 'react';
import {
  Scissors,
  Play,
  Flame,
  Clock,
  Crop,
  Copy,
  Check,
  Cpu,
  Share2,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { ClipSuggestion } from '../types/index.ts';

interface ClipCardProps {
  clip: ClipSuggestion;
  index: number;
  isActive: boolean;
  onPreview: (clip: ClipSuggestion) => void;
  onRender: (clip: ClipSuggestion, aspectRatio: '9:16' | '1:1' | '16:9') => void;
  onUpdateTimes: (clipId: string, startTime: number, endTime: number) => void;
  onReview?: (clip: ClipSuggestion) => void;
  onPublish?: (clip: ClipSuggestion) => void;
  maxDuration: number;
}

export const ClipCard: React.FC<ClipCardProps> = ({
  clip,
  index,
  isActive,
  onPreview,
  onRender,
  onUpdateTimes,
  onReview,
  onPublish,
  maxDuration,
}) => {
  const [aspectRatio, setAspectRatio] = useState<'9:16' | '1:1' | '16:9'>(
    clip.suggestedAspectRatio || '9:16'
  );
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  // Time editing
  const [start, setStart] = useState(clip.startTime);
  const [end, setEnd] = useState(clip.endTime);

  const duration = Math.max(0.5, Math.round((end - start) * 10) / 10);

  const handleStartChange = (val: number) => {
    const safeVal = Math.max(0, Math.min(val, end - 1));
    setStart(safeVal);
    onUpdateTimes(clip.id, safeVal, end);
  };

  const handleEndChange = (val: number) => {
    const safeVal = Math.min(maxDuration, Math.max(val, start + 1));
    setEnd(safeVal);
    onUpdateTimes(clip.id, start, safeVal);
  };

  const handleCopyCaption = () => {
    const text = `${clip.title}\n\n"${clip.hook}"\n\n${clip.hashtags.join(' ')}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatSecs = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  // Virality score colors
  const getScoreBadge = (score: number) => {
    if (score >= 90) {
      return {
        bg: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
        ring: 'text-emerald-400',
      };
    }
    if (score >= 80) {
      return {
        bg: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300',
        ring: 'text-cyan-400',
      };
    }
    return {
      bg: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
      ring: 'text-amber-400',
    };
  };

  const scoreBadge = getScoreBadge(clip.viralityScore);

  return (
    <div
      className={`group rounded-2xl border transition-all duration-200 overflow-hidden ${
        isActive
          ? 'border-violet-500 bg-neutral-900/90 shadow-xl shadow-violet-500/10 ring-1 ring-violet-500/50'
          : 'border-neutral-800 bg-neutral-900/60 hover:border-neutral-700 hover:bg-neutral-900'
      }`}
    >
      <div className="p-4 sm:p-5">
        {/* Header: Title + Virality Score */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-violet-500/20 px-2 py-0.5 text-[11px] font-bold text-violet-300 border border-violet-500/30">
                Clip #{index + 1}
              </span>
              <span className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-neutral-400">
                {clip.targetPlatform.toUpperCase()}
              </span>
              {/* Review / Publish Lifecycle Status */}
              <span
                className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                  clip.publishStatus === 'published'
                    ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30'
                    : clip.reviewStatus === 'approved'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : clip.reviewStatus === 'rejected'
                    ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                }`}
              >
                {clip.publishStatus === 'published'
                  ? 'Published'
                  : clip.reviewStatus === 'approved'
                  ? 'Approved'
                  : clip.reviewStatus === 'rejected'
                  ? 'Rejected'
                  : 'Needs Review'}
              </span>
            </div>
            <h4 className="mt-1.5 text-base font-bold text-white tracking-tight">{clip.title}</h4>
            {/* Viral Metrics Breakdown Pills */}
            {clip.scores && (
              <div className="flex items-center gap-2 mt-1.5 text-[10px]">
                <span className="text-neutral-400">
                  Hook: <strong className="text-white font-mono">{clip.scores.hook.toFixed(1)}</strong>
                </span>
                <span className="text-neutral-600">•</span>
                <span className="text-neutral-400">
                  Standalone: <strong className="text-white font-mono">{clip.scores.standalone.toFixed(1)}</strong>
                </span>
                <span className="text-neutral-600">•</span>
                <span className="text-neutral-400">
                  Payoff: <strong className="text-white font-mono">{clip.scores.payoff.toFixed(1)}</strong>
                </span>
              </div>
            )}
          </div>

          {/* Virality Score Badge */}
          <div
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 ${scoreBadge.bg}`}
            title="Estimated Virality Score based on hook strength, emotional impact & curiosity gap"
          >
            <Flame className={`h-4 w-4 ${scoreBadge.ring}`} />
            <div>
              <span className="text-sm font-black">{clip.viralityScore}</span>
              <span className="text-[10px] opacity-70">/100</span>
            </div>
          </div>
        </div>

        {/* Hook quote preview */}
        <div className="mt-3 rounded-xl border border-neutral-800 bg-neutral-950/70 p-3">
          <p className="text-xs italic text-neutral-300">
            "{clip.hook}"
          </p>
        </div>

        {/* Timestamp fine-tuning controls */}
        <div className="mt-4 rounded-xl border border-neutral-800/80 bg-neutral-950/50 p-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-neutral-400">
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5 text-violet-400" /> Time Range:
            </span>
            <span className="font-mono text-white font-medium">
              {formatSecs(start)} - {formatSecs(end)} ({duration.toFixed(1)}s)
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <div>
              <label className="text-[10px] text-neutral-400 block mb-0.5">Start Time (s)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                max={end - 0.5}
                value={start}
                onChange={(e) => handleStartChange(parseFloat(e.target.value) || 0)}
                className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-mono text-white focus:border-violet-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[10px] text-neutral-400 block mb-0.5">End Time (s)</label>
              <input
                type="number"
                step="0.1"
                min={start + 0.5}
                max={maxDuration}
                value={end}
                onChange={(e) => handleEndChange(parseFloat(e.target.value) || start + 1)}
                className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-mono text-white focus:border-violet-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Aspect Ratio & Rendering Controls */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-neutral-800">
          {/* Aspect Ratio Selector */}
          <div className="flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-950 p-0.5 text-xs">
            <button
              onClick={() => setAspectRatio('9:16')}
              className={`rounded px-2 py-1 font-medium text-[11px] transition ${
                aspectRatio === '9:16'
                  ? 'bg-violet-600 text-white'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              9:16 Shorts
            </button>
            <button
              onClick={() => setAspectRatio('1:1')}
              className={`rounded px-2 py-1 font-medium text-[11px] transition ${
                aspectRatio === '1:1'
                  ? 'bg-indigo-600 text-white'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              1:1 Square
            </button>
            <button
              onClick={() => setAspectRatio('16:9')}
              className={`rounded px-2 py-1 font-medium text-[11px] transition ${
                aspectRatio === '16:9'
                  ? 'bg-neutral-700 text-white'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              16:9 Orig
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onPreview(clip)}
              className="flex items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-700 transition"
              title="Preview clip segment in video player"
            >
              <Play className="h-3 w-3 fill-current" />
              <span>Preview</span>
            </button>

            {onReview && (
              <button
                type="button"
                onClick={() => onReview(clip)}
                className="flex items-center gap-1 rounded-lg border border-violet-500/40 bg-violet-950/40 px-2.5 py-1.5 text-xs font-semibold text-violet-300 hover:bg-violet-900/50 transition"
                title="Review viral metrics, story structure, weaknesses & alternate hooks"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-violet-400" />
                <span>Review</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => onRender(clip, aspectRatio)}
              className="flex items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-neutral-700 transition"
              title="Render vertical MP4 via FFmpeg"
            >
              <Cpu className="h-3.5 w-3.5 text-indigo-400" />
              <span>Render</span>
            </button>

            {onPublish && (
              <button
                type="button"
                onClick={() => onPublish(clip)}
                className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-bold transition shadow-md ${
                  clip.publishStatus === 'published'
                    ? 'bg-fuchsia-600/30 text-fuchsia-300 border border-fuchsia-500/40 hover:bg-fuchsia-600/40'
                    : 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-violet-600/20 hover:from-violet-500 hover:to-indigo-500'
                }`}
                title="Publish clip individually to TikTok, Shorts, Reels"
              >
                <Share2 className="h-3.5 w-3.5" />
                <span>{clip.publishStatus === 'published' ? 'Published' : 'Publish'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Expandable viral details & social copy */}
        <div className="mt-3 pt-2">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-200 transition"
          >
            {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            <span>{showDetails ? 'Hide Virality Insights' : 'View Virality Analysis & Social Copy'}</span>
          </button>

          {showDetails && (
            <div className="mt-3 space-y-2 rounded-xl bg-neutral-950/80 p-3 text-xs border border-neutral-850">
              <div>
                <span className="font-semibold text-neutral-300">Why it works: </span>
                <span className="text-neutral-400">{clip.viralityReason}</span>
              </div>
              <div className="flex flex-wrap gap-1 pt-1">
                {clip.hashtags.map((tag, i) => (
                  <span
                    key={i}
                    className="rounded bg-violet-950/50 px-2 py-0.5 text-[10px] text-violet-300 border border-violet-800/40"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <div className="pt-2 flex justify-end">
                <button
                  onClick={handleCopyCaption}
                  className="flex items-center gap-1 rounded bg-neutral-800 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700 transition"
                >
                  {copied ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-400" />
                      <span>Copied Caption & Tags!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>Copy Caption & Tags</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
