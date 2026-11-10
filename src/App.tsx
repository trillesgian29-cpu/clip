import React, { useState, useEffect } from 'react';
import {
  Film,
  Sparkles,
  Scissors,
  Layers,
  Cpu,
  Database,
  ArrowRight,
  RefreshCw,
  FolderOpen,
  CheckCircle2,
  AlertTriangle,
  PlaySquare,
  Zap,
  CheckSquare,
  Square,
  ShieldCheck,
  Share2,
  Trash2,
  Filter,
} from 'lucide-react';
import { Navbar } from './components/Navbar.tsx';
import { AuthModal } from './components/AuthModal.tsx';
import { SettingsModal } from './components/SettingsModal.tsx';
import { VideoUploader } from './components/VideoUploader.tsx';
import { VideoPlayer } from './components/VideoPlayer.tsx';
import { AiAnalysisPanel } from './components/AiAnalysisPanel.tsx';
import { ClipCard } from './components/ClipCard.tsx';
import { RenderQueue } from './components/RenderQueue.tsx';
import { ClipReviewModal } from './components/ClipReviewModal.tsx';
import { PublishClipModal } from './components/PublishClipModal.tsx';
import { api } from './services/api.ts';
import {
  VideoMetadata,
  ClipSuggestion,
  RenderJob,
  SystemStatus,
  PublishedClip,
} from './types/index.ts';

export default function App() {
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  // Studio Workflow State
  const [sourceVideo, setSourceVideo] = useState<VideoMetadata | null>(null);
  const [savedVideos, setSavedVideos] = useState<VideoMetadata[]>([]);
  const [clips, setClips] = useState<ClipSuggestion[]>([]);
  const [activeClip, setActiveClip] = useState<ClipSuggestion | null>(null);
  const [renderJobs, setRenderJobs] = useState<RenderJob[]>([]);
  const [aspectRatioPreview, setAspectRatioPreview] = useState<'9:16' | '1:1' | '16:9'>('9:16');

  // Coordinated Single-Player & Selection State
  const [activePlayingClipId, setActivePlayingClipId] = useState<string | null>(null);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);

  // Review-First & Individual Publishing Workflow States
  const [reviewingClip, setReviewingClip] = useState<ClipSuggestion | null>(null);
  const [publishingClip, setPublishingClip] = useState<ClipSuggestion | null>(null);
  const [publishedClips, setPublishedClips] = useState<PublishedClip[]>([]);
  const [clipFilter, setClipFilter] = useState<'all' | 'needs_review' | 'approved' | 'published'>('all');

  // Loading States
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentTab, setCurrentTab] = useState<'clips' | 'queue'>('clips');

  // Notification Banner
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'info' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Fetch initial system health, authentication, persistent videos & published clips
  const fetchInitialData = async () => {
    try {
      const status = await api.getSystemStatus();
      setSystemStatus(status);
      const isAuth = await api.checkAuth();
      setIsAuthenticated(isAuth);
      const pubs = await api.getPublishedClips();
      setPublishedClips(pubs);
      const vids = await api.getVideos();
      setSavedVideos(vids);
    } catch (err) {
      console.warn('Initial data load warning:', err);
    }
  };

  useEffect(() => {
    fetchInitialData();
  }, []);

  // Poll active render jobs
  useEffect(() => {
    const hasActiveJobs = renderJobs.some((j) => j.status === 'rendering' || j.status === 'queued');
    if (!hasActiveJobs) return;

    const interval = setInterval(async () => {
      try {
        const updatedJobs = await Promise.all(
          renderJobs.map(async (job) => {
            if (job.status === 'rendering' || job.status === 'queued') {
              return await api.getRenderJobStatus(job.id);
            }
            return job;
          })
        );
        setRenderJobs(updatedJobs);

        // Check if any job completed just now
        const newlyCompleted = updatedJobs.find(
          (uj) => uj.status === 'completed' && renderJobs.find((rj) => rj.id === uj.id)?.status !== 'completed'
        );
        if (newlyCompleted) {
          showToast(`FFmpeg finished rendering: "${newlyCompleted.title}"! Ready to download.`, 'success');
        }
      } catch (err) {
        console.error('Error polling render jobs:', err);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [renderJobs]);

  // Handle Video Uploaded or Selected
  const handleVideoLoaded = (video: VideoMetadata) => {
    setSourceVideo(video);
    setClips([]);
    setSelectedClipIds([]);
    setActiveClip(null);
    setActivePlayingClipId(null);
    setCurrentTab('clips');
    // Refresh library list
    api.getVideos().then(setSavedVideos).catch(() => {});
    showToast(`Loaded source video "${video.originalName}" (${video.duration}s)`, 'success');
  };

  // Delete a saved video from disk & database
  const handleDeleteVideo = async (videoId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Permanently delete this source video and its cached files?')) return;
    try {
      await api.deleteVideo(videoId);
      setSavedVideos((prev) => prev.filter((v) => v.id !== videoId));
      if (sourceVideo?.id === videoId) {
        setSourceVideo(null);
        setClips([]);
      }
      showToast('Video deleted from disk and registry', 'info');
    } catch (err) {
      showToast(`Delete failed: ${(err as Error).message}`, 'error');
    }
  };

  // Handle Clips Generated by Nemotron or Gemini
  const handleClipsGenerated = (newClips: ClipSuggestion[]) => {
    setClips(newClips);
    // Select all clips by default for batch operations
    setSelectedClipIds(newClips.map((c) => c.id));
    if (newClips.length > 0) {
      setActiveClip(newClips[0]);
    }
    showToast(`Extracted ${newClips.length} high-confidence moments!`, 'success');
  };

  // Handle Manual Time Updates from Clip Card
  const handleUpdateTimes = (clipId: string, startTime: number, endTime: number) => {
    setClips((prev) =>
      prev.map((c) =>
        c.id === clipId
          ? {
              ...c,
              startTime,
              endTime,
              duration: Math.round((endTime - startTime) * 10) / 10,
            }
          : c
      )
    );
  };

  // Multi-clip Selection Toggles
  const handleToggleSelect = (clipId: string) => {
    setSelectedClipIds((prev) =>
      prev.includes(clipId) ? prev.filter((id) => id !== clipId) : [...prev, clipId]
    );
  };

  const handleSelectAll = () => {
    setSelectedClipIds(clips.map((c) => c.id));
  };

  const handleDeselectAll = () => {
    setSelectedClipIds([]);
  };

  // Trigger FFmpeg Render
  const handleRenderClip = async (clip: ClipSuggestion, aspectRatio: '9:16' | '1:1' | '16:9') => {
    if (!sourceVideo) return;

    try {
      showToast(`Queued FFmpeg render for "${clip.title}" (${aspectRatio})...`, 'info');
      setCurrentTab('queue');

      const job = await api.renderClip({
        sourceVideoId: sourceVideo.id,
        clipId: clip.id,
        title: clip.title,
        startTime: clip.startTime,
        endTime: clip.endTime,
        aspectRatio,
      });

      setRenderJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    } catch (err) {
      showToast(`Rendering dispatch failed: ${(err as Error).message}`, 'error');
    }
  };

  // Batch Render Selected Clips
  const handleBatchRenderSelected = () => {
    if (!sourceVideo || selectedClipIds.length === 0) return;
    const targetClips = clips.filter((c) => selectedClipIds.includes(c.id));
    targetClips.forEach((clip) => handleRenderClip(clip, '9:16'));
    showToast(`Queued ${targetClips.length} clips for FFmpeg batch rendering!`, 'info');
  };

  // Remove / Delete Render Job from server
  const handleClearJob = async (jobId: string) => {
    try {
      await api.deleteRenderJob(jobId);
      setRenderJobs((prev) => prev.filter((j) => j.id !== jobId));
      showToast('Render job deleted from server (downloaded files unaffected)', 'info');
    } catch {
      setRenderJobs((prev) => prev.filter((j) => j.id !== jobId));
    }
  };

  // Review-first actions
  const handleApproveClip = (approvedClip: ClipSuggestion | string) => {
    const clipId = typeof approvedClip === 'string' ? approvedClip : approvedClip.id;
    setClips((prev) =>
      prev.map((c) =>
        c.id === clipId
          ? {
              ...(typeof approvedClip === 'string' ? c : approvedClip),
              reviewStatus: 'approved',
            }
          : c
      )
    );
    showToast('Clip marked as Approved for publishing', 'success');
  };

  const handleRejectClip = (clipId: string) => {
    setClips((prev) =>
      prev.map((c) => (c.id === clipId ? { ...c, reviewStatus: 'rejected' } : c))
    );
    showToast('Clip marked as Rejected', 'info');
  };

  const handleUpdateClipFromReview = (updatedClip: ClipSuggestion) => {
    setClips((prev) =>
      prev.map((c) => (c.id === updatedClip.id ? updatedClip : c))
    );
  };

  const handlePublishedSuccess = (publishedRecord: PublishedClip) => {
    setPublishedClips((prev) => [publishedRecord, ...prev]);
    setClips((prev) =>
      prev.map((c) => (c.id === publishedRecord.clipId ? { ...c, publishStatus: 'published' } : c))
    );
    showToast(`Clip published successfully to ${publishedRecord.platform.toUpperCase()}!`, 'success');
  };

  // Filter clips based on review/publish status
  const filteredClips = clips.filter((clip) => {
    if (clipFilter === 'all') return true;
    if (clipFilter === 'needs_review') return !clip.reviewStatus || clip.reviewStatus === 'needs_review';
    if (clipFilter === 'approved') return clip.reviewStatus === 'approved';
    if (clipFilter === 'published') return clip.publishStatus === 'published';
    return true;
  });

  // Reset Session
  const handleNewSession = () => {
    if (sourceVideo && confirm('Start a new session? Current active clips will be cleared.')) {
      setSourceVideo(null);
      setClips([]);
      setSelectedClipIds([]);
      setActiveClip(null);
      setActivePlayingClipId(null);
      showToast('Started fresh session', 'info');
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans selection:bg-violet-500/30 selection:text-white">
      {/* Studio Header */}
      <Navbar
        systemStatus={systemStatus}
        isAuthenticated={isAuthenticated}
        onOpenAuth={() => setIsAuthModalOpen(true)}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        onNewProject={handleNewSession}
      />

      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-16 right-4 z-50 flex items-center gap-2 rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-3 text-xs font-semibold shadow-2xl animate-in fade-in slide-in-from-top-2">
          {toast.type === 'success' && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
          {toast.type === 'error' && <AlertTriangle className="h-4 w-4 text-red-400" />}
          {toast.type === 'info' && <Sparkles className="h-4 w-4 text-violet-400" />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Main Studio Body */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        {!sourceVideo ? (
          /* Empty / Upload View */
          <div className="mx-auto max-w-4xl py-6 sm:py-12 space-y-8">
            <div className="text-center space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-950/30 px-3.5 py-1 text-xs font-semibold text-violet-300">
                <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                <span>NVIDIA Nemotron 3.5 Super VL + Gemini 3.8 Flash Engine</span>
              </div>
              <h1 className="text-3xl sm:text-5xl font-black tracking-tight text-white">
                Turn 2–3 Hour Videos <span className="bg-gradient-to-r from-violet-400 via-indigo-300 to-fuchsia-400 bg-clip-text text-transparent">(Up to 20 GB)</span> into Viral Clips
              </h1>
              <p className="text-sm sm:text-base text-neutral-400 max-w-2xl mx-auto">
                Powered by Resumable Chunked Uploads, NVIDIA Nemotron 3.5 Super VL moment detection, and native FFmpeg vertical 9:16 rendering with zero RAM buffering.
              </p>
            </div>

            <VideoUploader
              onVideoLoaded={handleVideoLoaded}
              isLoading={isVideoLoading}
              setIsLoading={setIsVideoLoading}
            />

            {/* Saved Videos Library (Persistent across server restarts) */}
            {savedVideos.length > 0 && (
              <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="h-4 w-4 text-violet-400" />
                    <h3 className="text-sm font-bold text-white">Saved Videos on Disk ({savedVideos.length})</h3>
                  </div>
                  <span className="text-xs text-neutral-500">Pick any video to resume editing</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {savedVideos.map((v) => (
                    <div
                      key={v.id}
                      onClick={() => handleVideoLoaded(v)}
                      className="group cursor-pointer rounded-xl border border-neutral-800 bg-neutral-950/70 p-3 hover:border-violet-500 hover:bg-neutral-900 transition flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-bold text-white truncate max-w-[200px]" title={v.originalName}>
                            {v.originalName}
                          </p>
                          <button
                            type="button"
                            onClick={(e) => handleDeleteVideo(v.id, e)}
                            className="text-neutral-500 hover:text-red-400 p-1 rounded transition"
                            title="Delete from disk"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                        <p className="mt-1 text-[11px] font-mono text-neutral-400">
                          {Math.floor(v.duration / 60)}m {Math.round(v.duration % 60)}s • {v.width}x{v.height}
                        </p>
                      </div>
                      <div className="mt-3 flex items-center justify-between text-[10px] text-neutral-500 pt-2 border-t border-neutral-850">
                        <span>{(v.size / (1024 * 1024)).toFixed(1)} MB</span>
                        <span className="text-violet-400 font-semibold group-hover:translate-x-0.5 transition">
                          Open Studio →
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Active Editing Workspace */
          <div className="space-y-6">
            {/* Top Workspace Grid: Player + AI Studio Controls */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left/Main Column: Video Player & Framing (7 cols) */}
              <div className="lg:col-span-7 space-y-4">
                <VideoPlayer
                  video={sourceVideo}
                  clips={clips}
                  activeClip={activeClip}
                  onSelectClip={(c) => setActiveClip(c)}
                  aspectRatioPreview={aspectRatioPreview}
                  setAspectRatioPreview={setAspectRatioPreview}
                />

                {/* Source Video Info Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-800/80 bg-neutral-900/60 px-4 py-3 text-xs">
                  <div className="flex items-center gap-2">
                    <Film className="h-4 w-4 text-violet-400" />
                    <span className="font-semibold text-white truncate max-w-xs">
                      {sourceVideo.originalName}
                    </span>
                    <span className="text-neutral-500">•</span>
                    <span className="font-mono text-neutral-400">
                      {sourceVideo.width}x{sourceVideo.height} ({sourceVideo.fps || 30}fps)
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="font-mono text-neutral-300">
                      Duration: {Math.floor(sourceVideo.duration / 60)}m {Math.round(sourceVideo.duration % 60)}s
                    </span>
                    <button
                      onClick={() => setSourceVideo(null)}
                      className="text-neutral-400 hover:text-red-400 transition"
                      title="Replace source video"
                    >
                      Change Video
                    </button>
                  </div>
                </div>
              </div>

              {/* Right Column: AI Analysis Panel (5 cols) */}
              <div className="lg:col-span-5 space-y-4">
                <AiAnalysisPanel
                  video={sourceVideo}
                  onClipsGenerated={handleClipsGenerated}
                  isAnalyzing={isAnalyzing}
                  setIsAnalyzing={setIsAnalyzing}
                />

                {/* Quick Stats Widget */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-center">
                    <p className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                      Curated Clips
                    </p>
                    <p className="mt-1 text-lg font-black text-violet-400">{clips.length}</p>
                  </div>
                  <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-center">
                    <p className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                      FFmpeg Jobs
                    </p>
                    <p className="mt-1 text-lg font-black text-indigo-400">{renderJobs.length}</p>
                  </div>
                  <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-center">
                    <p className="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">
                      Avg Score
                    </p>
                    <p className="mt-1 text-lg font-black text-emerald-400">
                      {clips.length
                        ? Math.round(clips.reduce((a, b) => a + b.viralityScore, 0) / clips.length)
                        : '--'}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Workspace: Tabs for Curated Clips vs Render Queue */}
            <div className="pt-4 border-t border-neutral-800/80 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 border-b border-neutral-800 pb-1">
                  <button
                    onClick={() => setCurrentTab('clips')}
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-t-xl transition ${
                      currentTab === 'clips'
                        ? 'border-b-2 border-violet-500 text-white bg-neutral-900/60'
                        : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    <Scissors className="h-4 w-4" />
                    <span>AI Curated Clips ({clips.length})</span>
                  </button>

                  <button
                    onClick={() => setCurrentTab('queue')}
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-t-xl transition ${
                      currentTab === 'queue'
                        ? 'border-b-2 border-violet-500 text-white bg-neutral-900/60'
                        : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    <Layers className="h-4 w-4" />
                    <span>FFmpeg Render Queue & Downloads ({renderJobs.length})</span>
                    {renderJobs.some((j) => j.status === 'rendering') && (
                      <span className="h-2 w-2 rounded-full bg-violet-400 animate-pulse" />
                    )}
                  </button>
                </div>

                {/* Batch Action Controls */}
                {clips.length > 0 && currentTab === 'clips' && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Select All / Deselect All */}
                    <div className="flex items-center gap-1 bg-neutral-900 border border-neutral-800 rounded-lg p-0.5 text-xs">
                      <button
                        onClick={handleSelectAll}
                        className="px-2.5 py-1 text-[11px] text-neutral-300 hover:text-white rounded hover:bg-neutral-800 transition"
                      >
                        Select All
                      </button>
                      <button
                        onClick={handleDeselectAll}
                        className="px-2.5 py-1 text-[11px] text-neutral-400 hover:text-white rounded hover:bg-neutral-800 transition"
                      >
                        Clear
                      </button>
                    </div>

                    <button
                      onClick={handleBatchRenderSelected}
                      disabled={selectedClipIds.length === 0}
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                        selectedClipIds.length > 0
                          ? 'border border-violet-500/50 bg-violet-600 text-white shadow-lg shadow-violet-600/20 hover:bg-violet-500'
                          : 'border border-neutral-800 bg-neutral-900 text-neutral-500 cursor-not-allowed'
                      }`}
                    >
                      <Zap className="h-3.5 w-3.5" />
                      <span>Render Selected ({selectedClipIds.length})</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Tab Content: Clips List */}
              {currentTab === 'clips' && (
                <div className="space-y-4">
                  {/* Filter Sub-Tabs */}
                  {clips.length > 0 && (
                    <div className="flex items-center justify-between flex-wrap gap-2 pt-1 pb-2 border-b border-neutral-850">
                      <div className="flex items-center gap-1 text-xs">
                        <Filter className="h-3.5 w-3.5 text-neutral-500 mr-1" />
                        <button
                          onClick={() => setClipFilter('all')}
                          className={`rounded-lg px-2.5 py-1 font-semibold transition ${
                            clipFilter === 'all'
                              ? 'bg-neutral-800 text-white'
                              : 'text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          All ({clips.length})
                        </button>
                        <button
                          onClick={() => setClipFilter('needs_review')}
                          className={`rounded-lg px-2.5 py-1 font-semibold transition ${
                            clipFilter === 'needs_review'
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                              : 'text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          Needs Review ({clips.filter((c) => !c.reviewStatus || c.reviewStatus === 'needs_review').length})
                        </button>
                        <button
                          onClick={() => setClipFilter('approved')}
                          className={`rounded-lg px-2.5 py-1 font-semibold transition ${
                            clipFilter === 'approved'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          Approved ({clips.filter((c) => c.reviewStatus === 'approved').length})
                        </button>
                        <button
                          onClick={() => setClipFilter('published')}
                          className={`rounded-lg px-2.5 py-1 font-semibold transition ${
                            clipFilter === 'published'
                              ? 'bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30'
                              : 'text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          Published ({clips.filter((c) => c.publishStatus === 'published').length})
                        </button>
                      </div>

                      <span className="text-[11px] text-neutral-500">
                        Showing {filteredClips.length} of {clips.length} moments
                      </span>
                    </div>
                  )}

                  {clips.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/30 p-12 text-center">
                      <Sparkles className="mx-auto h-8 w-8 text-violet-400 mb-2" />
                      <h4 className="text-sm font-bold text-white">No Clips Generated Yet</h4>
                      <p className="text-xs text-neutral-400 mt-1 max-w-sm mx-auto">
                        Click "Analyze Moments with Nemotron 3.5 Super VL" above to extract high-retention clips.
                      </p>
                    </div>
                  ) : filteredClips.length === 0 ? (
                    <div className="rounded-2xl border border-neutral-850 bg-neutral-900/20 p-8 text-center text-xs text-neutral-400">
                      No clips match filter "{clipFilter.replace('_', ' ')}".
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                      {filteredClips.map((clip, idx) => (
                        <ClipCard
                          key={clip.id}
                          clip={clip}
                          index={idx}
                          sourceVideoId={sourceVideo.id}
                          isSelected={selectedClipIds.includes(clip.id)}
                          onToggleSelect={handleToggleSelect}
                          isInlinePlaying={activePlayingClipId === clip.id}
                          onToggleInlinePlay={(id) =>
                            setActivePlayingClipId((prev) => (prev === id ? null : id))
                          }
                          isActive={activeClip?.id === clip.id}
                          onPreview={(c) => setActiveClip(c)}
                          onRender={handleRenderClip}
                          onReview={(c) => setReviewingClip(c)}
                          onPublish={(c) => setPublishingClip(c)}
                          onUpdateTimes={handleUpdateTimes}
                          maxDuration={sourceVideo.duration}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Tab Content: Render Queue */}
              {currentTab === 'queue' && (
                <RenderQueue jobs={renderJobs} onClearJob={handleClearJob} />
              )}
            </div>
          </div>
        )}
      </main>

      {/* Review-First Modal */}
      {reviewingClip && (
        <ClipReviewModal
          isOpen={Boolean(reviewingClip)}
          clip={reviewingClip}
          videoDuration={sourceVideo?.duration || 100}
          onClose={() => setReviewingClip(null)}
          onApprove={(c: ClipSuggestion) => {
            handleApproveClip(c);
            setReviewingClip(null);
          }}
          onReject={(id: string) => {
            handleRejectClip(id);
            setReviewingClip(null);
          }}
          onProceedToPublish={(clipToPublish: ClipSuggestion) => {
            setReviewingClip(null);
            setPublishingClip(clipToPublish);
          }}
          onPreview={(c: ClipSuggestion) => setActiveClip(c)}
        />
      )}

      {/* Publish Clip Modal */}
      {publishingClip && (
        <PublishClipModal
          isOpen={Boolean(publishingClip)}
          clip={publishingClip}
          renderJob={renderJobs.find((j) => j.clipId === publishingClip.id)}
          onClose={() => setPublishingClip(null)}
          onPublishedSuccess={handlePublishedSuccess}
          onRequestRender={(c, aspect) => handleRenderClip(c, aspect)}
        />
      )}

      {/* Modals */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        isAuthenticated={isAuthenticated}
        onAuthChange={setIsAuthenticated}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        systemStatus={systemStatus}
      />

      {/* Studio Footer */}
      <footer className="mt-auto border-t border-neutral-800/60 bg-neutral-950 py-4 text-center text-xs text-neutral-500">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6">
          <p>© 2026 ClipGenius AI • NVIDIA Nemotron 3.5 Super VL • FFmpeg 9:16 Render • Supabase Sync</p>
          <div className="flex items-center gap-4 text-[11px]">
            <button
              onClick={() => setIsSettingsModalOpen(true)}
              className="hover:text-neutral-300 transition"
            >
              Diagnostics & Schema
            </button>
            <button
              onClick={() => setIsAuthModalOpen(true)}
              className="hover:text-neutral-300 transition"
            >
              Owner Gate
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
