import React, { useState, useRef, useEffect } from 'react';
import {
  Scissors,
  Play,
  Pause,
  RotateCcw,
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
  Sliders,
  CheckSquare,
  Square,
} from 'lucide-react';
import { ClipSuggestion } from '../types/index.ts';

interface ClipCardProps {
  clip: ClipSuggestion;
  index: number;
  isActive: boolean;
  sourceVideoId?: string;
  isSelected?: boolean;
  onToggleSelect?: (clipId: string) => void;
  isInlinePlaying?: boolean;
  onToggleInlinePlay?: (clipId: string) => void;
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
  sourceVideoId,
  isSelected = false,
  onToggleSelect,
  isInlinePlaying = false,
  onToggleInlinePlay,
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
  const [showTimeFineTune, setShowTimeFineTune] = useState(false);

  // Time editing state
  const [start, setStart] = useState(clip.startTime);
  const [end, setEnd] = useState(clip.endTime);

  // Video element ref for inline playback
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(start);
  const [isPlaying, setIsPlaying] = useState(false);

  const duration = Math.max(0.5, Math.round((end - start) * 10) / 10);
  const effectiveSourceVideoId = sourceVideoId || clip.sourceVideoId;
  const thumbnailUrl = effectiveSourceVideoId
    ? `/api/thumbnails/clip/${effectiveSourceVideoId}?t=${Math.round(start)}`
    : clip.thumbnailUrl;

  // Handle start time modification
  const handleStartChange = (val: number) => {
    const safeVal = Math.max(0, Math.min(val, end - 0.5));
    setStart(safeVal);
    onUpdateTimes(clip.id, safeVal, end);
    if (videoRef.current && videoRef.current.currentTime < safeVal) {
      videoRef.current.currentTime = safeVal;
    }
  };

  // Handle end time modification
  const handleEndChange = (val: number) => {
    const safeVal = Math.min(maxDuration, Math.max(val, start + 0.5));
    setEnd(safeVal);
    onUpdateTimes(clip.id, start, safeVal);
    if (videoRef.current && videoRef.current.currentTime > safeVal) {
      videoRef.current.currentTime = safeVal;
    }
  };

  // Synchronize inline video time and loop bounds
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isInlinePlaying) {
      video.currentTime = start;
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, [isInlinePlaying, start]);

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);

    // Enforce clip bounds
    if (video.currentTime >= end) {
      video.pause();
      video.currentTime = start;
      setIsPlaying(false);
    }
  };

  const togglePlayPause = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleInlinePlay) {
      onToggleInlinePlay(clip.id);
    } else {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) {
        if (video.currentTime < start || video.currentTime >= end) {
          video.currentTime = start;
        }
        video.play().catch(() => {});
        setIsPlaying(true);
      } else {
        video.pause();
        setIsPlaying(false);
      }
    }
  };

  const handleReplay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = start;
    video.play().catch(() => {});
    setIsPlaying(true);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);
    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
    }
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
      className={`group rounded-2xl border transition-all duration-200 overflow-hidden flex flex-col justify-between ${
        isSelected
          ? 'border-violet-500 bg-neutral-900/95 shadow-xl shadow-violet-500/10 ring-2 ring-violet-500/60'
          : isActive
          ? 'border-violet-500/70 bg-neutral-900/90 shadow-lg shadow-violet-500/5'
          : 'border-neutral-800 bg-neutral-900/60 hover:border-neutral-700 hover:bg-neutral-900'
      }`}
    >
      <div>
        {/* Top Media Preview Area: Extracted Thumbnail or Inline Live Clip Preview */}
        <div className="relative aspect-video w-full bg-neutral-950 overflow-hidden border-b border-neutral-800">
          {effectiveSourceVideoId && isInlinePlaying ? (
            <div className="relative w-full h-full flex items-center justify-center bg-black">
              <video
                ref={videoRef}
                src={`/api/videos/stream/${effectiveSourceVideoId}#t=${start},${end}`}
                onTimeUpdate={handleTimeUpdate}
                playsInline
                className="w-full h-full object-contain"
              />

              {/* Inline player controls overlay */}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-2 flex flex-col gap-1">
                {/* Seek scrubber restricted between start and end */}
                <input
                  type="range"
                  min={start}
                  max={end}
                  step="0.05"
                  value={currentTime}
                  onChange={handleSeek}
                  className="w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-violet-500"
                />
                <div className="flex items-center justify-between text-[10px] text-neutral-300">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={togglePlayPause}
                      className="rounded bg-violet-600/80 p-1 text-white hover:bg-violet-600 transition"
                      title={isPlaying ? 'Pause clip' : 'Play clip'}
                    >
                      {isPlaying ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3 fill-current" />}
                    </button>
                    <button
                      type="button"
                      onClick={handleReplay}
                      className="rounded bg-neutral-800 p-1 text-neutral-300 hover:bg-neutral-700 transition"
                      title="Replay from clip start"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                    <span className="font-mono">
                      {formatSecs(currentTime - start)} / {formatSecs(duration)}
                    </span>
                  </div>
                  <span className="rounded bg-violet-950/80 px-1.5 py-0.5 text-[9px] font-mono text-violet-300 border border-violet-800/40">
                    {formatSecs(start)} - {formatSecs(end)}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div
              onClick={togglePlayPause}
              className="relative w-full h-full cursor-pointer group/thumb flex items-center justify-center bg-gradient-to-br from-neutral-900 to-neutral-950"
            >
              {thumbnailUrl ? (
                <img
                  src={thumbnailUrl}
                  alt={clip.title}
                  onError={(e) => {
                    // Fallback to stylized placeholder if frame extraction is in progress
                    (e.target as HTMLElement).style.display = 'none';
                  }}
                  className="w-full h-full object-cover transition duration-300 group-hover/thumb:scale-105"
                />
              ) : null}

              {/* Play Overlay */}
              <div className="absolute inset-0 bg-black/40 group-hover/thumb:bg-black/20 transition flex items-center justify-center">
                <div className="rounded-full bg-violet-600/90 p-3 text-white shadow-xl shadow-violet-600/30 group-hover/thumb:scale-110 transition duration-200">
                  <Play className="h-5 w-5 fill-current ml-0.5" />
                </div>
              </div>

              {/* Instant Preview Badge */}
              <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-black/80 px-2 py-1 text-[10px] font-mono font-medium text-white backdrop-blur-sm border border-neutral-700/60">
                <Clock className="h-3 w-3 text-violet-400" />
                <span>{duration.toFixed(1)}s</span>
              </div>

              <div className="absolute bottom-2 right-2 rounded-md bg-violet-900/80 px-2 py-0.5 text-[10px] font-bold text-violet-200 backdrop-blur-sm border border-violet-700/50">
                Preview Moment
              </div>
            </div>
          )}

          {/* Top Left Selection Checkbox */}
          {onToggleSelect && (
            <div className="absolute top-2 left-2 z-10">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(clip.id);
                }}
                className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold backdrop-blur-md transition border ${
                  isSelected
                    ? 'bg-violet-600 text-white border-violet-400 shadow-lg shadow-violet-600/30'
                    : 'bg-black/70 text-neutral-300 border-neutral-700 hover:text-white hover:border-neutral-500'
                }`}
              >
                {isSelected ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                <span className="text-[11px]">{isSelected ? 'Selected' : 'Select'}</span>
              </button>
            </div>
          )}

          {/* Top Right Virality Score Badge */}
          <div className="absolute top-2 right-2 z-10">
            <div
              className={`flex items-center gap-1 rounded-lg border px-2 py-1 backdrop-blur-md shadow-lg ${scoreBadge.bg}`}
              title="Estimated Virality Score based on hook strength, emotional impact & curiosity gap"
            >
              <Flame className={`h-3.5 w-3.5 ${scoreBadge.ring}`} />
              <span className="text-xs font-black">{clip.viralityScore}</span>
              <span className="text-[9px] opacity-70">/100</span>
            </div>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-5">
          {/* Header Tags & Title */}
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="rounded bg-violet-500/20 px-2 py-0.5 text-[11px] font-bold text-violet-300 border border-violet-500/30">
                Clip #{index + 1}
              </span>
              <span className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-neutral-400">
                {clip.targetPlatform ? clip.targetPlatform.toUpperCase() : 'SHORTS'}
              </span>
              {clip.evidenceMode && (
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-medium border ${
                    clip.evidenceMode === 'combined'
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : 'bg-sky-500/15 text-sky-300 border-sky-500/30'
                  }`}
                >
                  {clip.evidenceMode === 'combined' ? 'Visual + Transcript' : 'Visual-Only'}
                </span>
              )}
              {clip.boundaryAdjusted && (
                <span
                  className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300 border border-amber-500/30"
                  title={
                    clip.originalStartTime !== undefined && clip.originalEndTime !== undefined
                      ? `Original bounds ${clip.originalStartTime.toFixed(1)}s–${clip.originalEndTime.toFixed(1)}s trimmed cleanly`
                      : 'Boundary trimmed around transition'
                  }
                >
                  Transition-Trimmed
                </span>
              )}
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

            <h4 className="mt-2 text-base font-bold text-white tracking-tight leading-snug">
              {clip.title}
            </h4>

            {/* Viral Metrics Breakdown Pills */}
            {clip.scores && (
              <div className="flex items-center gap-2 mt-2 text-[10px] text-neutral-400 flex-wrap">
                <span>Hook: <strong className="text-white font-mono">{clip.scores.hook.toFixed(1)}</strong></span>
                <span className="text-neutral-600">•</span>
                <span>Flow: <strong className="text-white font-mono">{clip.scores.standalone.toFixed(1)}</strong></span>
                <span className="text-neutral-600">•</span>
                <span>Payoff: <strong className="text-white font-mono">{clip.scores.payoff.toFixed(1)}</strong></span>
              </div>
            )}
          </div>

          {/* Hook quote preview */}
          <div className="mt-3 rounded-xl border border-neutral-800 bg-neutral-950/70 p-3">
            <p className="text-xs italic text-neutral-300 line-clamp-2">
              "{clip.hook}"
            </p>
          </div>

          {/* Time boundaries fine-tuner */}
          <div className="mt-3 pt-1">
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span className="flex items-center gap-1 font-mono text-[11px] text-neutral-300">
                <Clock className="h-3 w-3 text-violet-400" />
                {formatSecs(start)} - {formatSecs(end)} ({duration.toFixed(1)}s)
              </span>
              <button
                type="button"
                onClick={() => setShowTimeFineTune(!showTimeFineTune)}
                className="text-[11px] text-violet-400 hover:text-violet-300 flex items-center gap-1 transition"
              >
                <Sliders className="h-3 w-3" />
                <span>{showTimeFineTune ? 'Close Slider' : 'Trim Times'}</span>
              </button>
            </div>

            {showTimeFineTune && (
              <div className="mt-2.5 rounded-xl border border-neutral-800/80 bg-neutral-950/60 p-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-neutral-400 block mb-0.5">Start (seconds)</label>
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
                    <label className="text-[10px] text-neutral-400 block mb-0.5">End (seconds)</label>
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
            )}
          </div>
        </div>
      </div>

      {/* Footer Actions: Aspect Selector + Review + Render + Publish */}
      <div className="p-4 sm:p-5 pt-0 border-t border-neutral-800/60 mt-3">
        <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
          {/* Aspect Ratio Selector */}
          <div className="flex items-center gap-0.5 rounded-lg border border-neutral-800 bg-neutral-950 p-0.5 text-xs">
            <button
              onClick={() => setAspectRatio('9:16')}
              className={`rounded px-2 py-1 font-medium text-[11px] transition ${
                aspectRatio === '9:16'
                  ? 'bg-violet-600 text-white font-bold'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              9:16
            </button>
            <button
              onClick={() => setAspectRatio('1:1')}
              className={`rounded px-2 py-1 font-medium text-[11px] transition ${
                aspectRatio === '1:1'
                  ? 'bg-indigo-600 text-white font-bold'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              1:1
            </button>
            <button
              onClick={() => setAspectRatio('16:9')}
              className={`rounded px-2 py-1 font-medium text-[11px] transition ${
                aspectRatio === '16:9'
                  ? 'bg-neutral-700 text-white font-bold'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              16:9
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-1.5">
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
              {clip.boundaryAdjusted && clip.originalStartTime !== undefined && clip.originalEndTime !== undefined && (
                <div className="text-[11px] text-amber-300/90">
                  <span className="font-semibold">Original Timeline: </span>
                  <span className="font-mono">
                    {clip.originalStartTime.toFixed(1)}s – {clip.originalEndTime.toFixed(1)}s
                  </span>{' '}
                  → Adjusted to <span className="font-mono">{clip.startTime.toFixed(1)}s – {clip.endTime.toFixed(1)}s</span>
                </div>
              )}
              {clip.transitionNotes && clip.transitionNotes.length > 0 && (
                <div className="text-[11px] text-neutral-400">
                  <span className="font-semibold text-neutral-300">Transition Inspection: </span>
                  <span>{clip.transitionNotes.join(' ')}</span>
                </div>
              )}
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
