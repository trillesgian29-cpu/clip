import React, { useRef, useState, useEffect } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Maximize,
  Crop,
  Layers,
  Sparkles,
  Scissors,
} from 'lucide-react';
import { VideoMetadata, ClipSuggestion } from '../types/index.ts';

interface VideoPlayerProps {
  video: VideoMetadata;
  clips: ClipSuggestion[];
  activeClip: ClipSuggestion | null;
  onSelectClip: (clip: ClipSuggestion) => void;
  aspectRatioPreview: '9:16' | '1:1' | '16:9';
  setAspectRatioPreview: (ratio: '9:16' | '1:1' | '16:9') => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  video,
  clips,
  activeClip,
  onSelectClip,
  aspectRatioPreview,
  setAspectRatioPreview,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(video.duration || 0);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);

  // Sync video duration when loaded
  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration || video.duration);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const time = videoRef.current.currentTime;
      setCurrentTime(time);

      // If active clip is set and we pass its endTime, loop back to startTime
      if (activeClip && time >= activeClip.endTime) {
        videoRef.current.currentTime = activeClip.startTime;
      }
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play().catch(console.error);
    }
    setIsPlaying(!isPlaying);
  };

  const seek = (timeInSeconds: number) => {
    if (!videoRef.current) return;
    const safeTime = Math.max(0, Math.min(duration, timeInSeconds));
    videoRef.current.currentTime = safeTime;
    setCurrentTime(safeTime);
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    seek(ratio * duration);
  };

  const skip = (delta: number) => {
    seek(currentTime + delta);
  };

  // Jump to clip when activeClip changes
  useEffect(() => {
    if (activeClip && videoRef.current) {
      videoRef.current.currentTime = activeClip.startTime;
      setCurrentTime(activeClip.startTime);
      if (!isPlaying) {
        videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
      }
    }
  }, [activeClip]);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
  };

  return (
    <div className="flex flex-col rounded-2xl border border-neutral-800 bg-neutral-900/90 overflow-hidden shadow-2xl">
      {/* Video Container & Framing Guides */}
      <div className="relative aspect-video w-full bg-black flex items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          src={video.url}
          className="h-full w-full object-contain"
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          playsInline
        />

        {/* 9:16 Vertical Preview Overlay (Darkening Sides) */}
        {aspectRatioPreview === '9:16' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {/* Left mask */}
            <div className="h-full flex-1 bg-black/75 border-r border-violet-500/40" />
            {/* Vertical 9:16 viewport */}
            <div className="h-full aspect-[9/16] border-2 border-dashed border-violet-400 relative">
              <span className="absolute top-2 left-2 rounded bg-violet-600/80 px-2 py-0.5 text-[10px] font-bold uppercase text-white tracking-wider backdrop-blur-sm">
                9:16 Shorts Crop
              </span>
            </div>
            {/* Right mask */}
            <div className="h-full flex-1 bg-black/75 border-l border-violet-500/40" />
          </div>
        )}

        {/* 1:1 Square Preview Overlay */}
        {aspectRatioPreview === '1:1' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-full flex-1 bg-black/70 border-r border-indigo-500/40" />
            <div className="h-full aspect-square border-2 border-dashed border-indigo-400 relative">
              <span className="absolute top-2 left-2 rounded bg-indigo-600/80 px-2 py-0.5 text-[10px] font-bold uppercase text-white tracking-wider backdrop-blur-sm">
                1:1 Square Crop
              </span>
            </div>
            <div className="h-full flex-1 bg-black/70 border-l border-indigo-500/40" />
          </div>
        )}

        {/* Active Clip Badge */}
        {activeClip && (
          <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-neutral-950/80 px-3 py-1.5 text-xs text-violet-300 backdrop-blur-md">
            <Scissors className="h-3.5 w-3.5 text-violet-400" />
            <span className="font-semibold">{activeClip.title}</span>
            <span className="text-neutral-400">
              ({formatTime(activeClip.startTime)} - {formatTime(activeClip.endTime)})
            </span>
          </div>
        )}
      </div>

      {/* Scrubber Timeline with Clip Region Markers */}
      <div className="px-4 pt-3 pb-1 bg-neutral-950 border-t border-neutral-800/80">
        <div
          ref={timelineRef}
          onClick={handleTimelineClick}
          className="relative h-4 w-full cursor-pointer select-none flex items-center group"
        >
          {/* Timeline background track */}
          <div className="h-2 w-full rounded-full bg-neutral-800 overflow-hidden relative">
            {/* Render clip highlight regions on timeline */}
            {clips.map((clip) => {
              const startPercent = (clip.startTime / (duration || 1)) * 100;
              const widthPercent = ((clip.endTime - clip.startTime) / (duration || 1)) * 100;
              const isActive = activeClip?.id === clip.id;

              return (
                <div
                  key={clip.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectClip(clip);
                  }}
                  style={{ left: `${startPercent}%`, width: `${widthPercent}%` }}
                  title={`${clip.title} (${clip.viralityScore} Viral Score)`}
                  className={`absolute top-0 bottom-0 cursor-pointer transition ${
                    isActive
                      ? 'bg-violet-500 shadow-md shadow-violet-500/50 z-10'
                      : 'bg-indigo-500/50 hover:bg-indigo-400 z-0'
                  }`}
                />
              );
            })}

            {/* Playhead progress */}
            <div
              className="h-full bg-white transition-all pointer-events-none"
              style={{ width: `${(currentTime / (duration || 1)) * 100}%` }}
            />
          </div>

          {/* Scrubber thumb handle */}
          <div
            className="absolute h-4 w-4 -ml-2 rounded-full bg-white shadow-lg pointer-events-none group-hover:scale-125 transition"
            style={{ left: `${(currentTime / (duration || 1)) * 100}%` }}
          />
        </div>

        {/* Timecodes */}
        <div className="flex items-center justify-between text-xs font-mono text-neutral-400 mt-1">
          <span>{formatTime(currentTime)}</span>
          <div className="flex items-center gap-2">
            {activeClip && (
              <span className="text-violet-400 font-sans text-[11px] font-medium">
                Looping clip ({activeClip.duration.toFixed(1)}s)
              </span>
            )}
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      </div>

      {/* Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-neutral-900 border-t border-neutral-800">
        {/* Playback Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => skip(-5)}
            className="rounded-lg p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 transition"
            title="Rewind 5s"
          >
            <RotateCcw className="h-4 w-4" />
          </button>

          <button
            onClick={togglePlay}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600 text-white shadow-lg shadow-violet-600/30 hover:bg-violet-500 transition"
          >
            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 fill-current ml-0.5" />}
          </button>

          <button
            onClick={() => skip(5)}
            className="rounded-lg p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 transition"
            title="Forward 5s"
          >
            <RotateCw className="h-4 w-4" />
          </button>

          {/* Volume */}
          <div className="flex items-center gap-1.5 ml-2">
            <button
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.muted = !isMuted;
                  setIsMuted(!isMuted);
                }
              }}
              className="text-neutral-400 hover:text-white"
            >
              {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setVolume(val);
                if (videoRef.current) {
                  videoRef.current.volume = val;
                  videoRef.current.muted = val === 0;
                  setIsMuted(val === 0);
                }
              }}
              className="w-16 h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-violet-500"
            />
          </div>
        </div>

        {/* Framing & Aspect Ratio Selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400 flex items-center gap-1">
            <Crop className="h-3.5 w-3.5" /> Aspect Frame:
          </span>
          <div className="flex rounded-lg border border-neutral-700 bg-neutral-950 p-0.5 text-xs">
            <button
              onClick={() => setAspectRatioPreview('9:16')}
              className={`rounded px-2.5 py-1 font-medium transition ${
                aspectRatioPreview === '9:16'
                  ? 'bg-violet-600 text-white shadow'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              9:16 Shorts
            </button>
            <button
              onClick={() => setAspectRatioPreview('1:1')}
              className={`rounded px-2.5 py-1 font-medium transition ${
                aspectRatioPreview === '1:1'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              1:1 Square
            </button>
            <button
              onClick={() => setAspectRatioPreview('16:9')}
              className={`rounded px-2.5 py-1 font-medium transition ${
                aspectRatioPreview === '16:9'
                  ? 'bg-neutral-700 text-white shadow'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              16:9 Full
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
