import React, { useState } from 'react';
import {
  X,
  Share2,
  Check,
  Copy,
  Calendar,
  Sparkles,
  Cpu,
  Download,
  ExternalLink,
  CheckCircle2,
  Loader2,
  Clock,
  Layers,
} from 'lucide-react';
import { ClipSuggestion, RenderJob, PublishedClip } from '../types/index.ts';
import { api } from '../services/api.ts';

interface PublishClipModalProps {
  clip: ClipSuggestion | null;
  renderJob?: RenderJob;
  isOpen: boolean;
  onClose: () => void;
  onPublishedSuccess: (publishedClip: PublishedClip) => void;
  onRequestRender?: (clip: ClipSuggestion, aspectRatio: '9:16' | '1:1' | '16:9') => void;
}

export const PublishClipModal: React.FC<PublishClipModalProps> = ({
  clip,
  renderJob,
  isOpen,
  onClose,
  onPublishedSuccess,
  onRequestRender,
}) => {
  if (!isOpen || !clip) return null;

  const [platform, setPlatform] = useState<'tiktok' | 'reels' | 'shorts' | 'facebook' | 'all'>(
    (clip.publishedPlatform as any) || (clip.targetPlatform as any) || 'tiktok'
  );
  const [postTitle, setPostTitle] = useState(clip.title);
  const [postHook, setPostHook] = useState(clip.hook);
  const [hashtags, setHashtags] = useState<string[]>(
    clip.hashtags && clip.hashtags.length ? clip.hashtags : ['#viral', '#shorts', '#trending', '#reels']
  );
  const [newTagInput, setNewTagInput] = useState('');
  const [caption, setCaption] = useState(
    `${clip.title}\n\n"${clip.hook}"\n\n${(clip.hashtags || ['#viral', '#shorts', '#fyp']).join(' ')}`
  );
  const [scheduledFor, setScheduledFor] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  const [copiedBundle, setCopiedBundle] = useState(false);
  const [publishedResult, setPublishedResult] = useState<PublishedClip | null>(null);

  const handleCopyBundle = () => {
    const bundleText = `🎬 TITLE:
${postTitle}

⚡ HOOK OVERLAY:
"${postHook}"

📝 CAPTION:
${caption}

🏷️ HASHTAGS:
${hashtags.join(' ')}

⏱️ TIMECODE:
${clip.startTime.toFixed(1)}s - ${clip.endTime.toFixed(1)}s (${clip.duration.toFixed(1)}s)`;

    navigator.clipboard.writeText(bundleText);
    setCopiedBundle(true);
    setTimeout(() => setCopiedBundle(false), 2500);
  };

  const handleAddTag = () => {
    if (!newTagInput.trim()) return;
    const tag = newTagInput.startsWith('#') ? newTagInput.trim() : `#${newTagInput.trim()}`;
    if (!hashtags.includes(tag)) {
      setHashtags([...hashtags, tag]);
    }
    setNewTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
    setHashtags(hashtags.filter((t) => t !== tag));
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    try {
      const result = await api.publishClip({
        clipId: clip.id,
        title: postTitle,
        hook: postHook,
        platform,
        postCaption: caption,
        hashtags,
        videoUrl: renderJob?.downloadUrl || undefined,
        downloadUrl: renderJob?.downloadUrl || undefined,
        renderJobId: renderJob?.id || undefined,
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
      });

      setPublishedResult(result.publishedClip);
      onPublishedSuccess(result.publishedClip);
    } catch (err) {
      alert(`Publishing failed: ${(err as Error).message}`);
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-md animate-in fade-in">
      <div className="relative w-full max-w-2xl max-h-[92vh] flex flex-col rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-md shadow-violet-600/30">
              <Share2 className="h-5 w-5" />
            </div>
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-violet-400">
                Individual Clip Publishing
              </span>
              <h3 className="text-base font-bold text-white tracking-tight mt-0.5">
                Publish & Distribute: "{clip.title}"
              </h3>
            </div>
          </div>

          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {publishedResult ? (
            /* Published Success Screen */
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/20 p-6 text-center space-y-4">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              <div>
                <h4 className="text-lg font-black text-white">Clip Published Successfully!</h4>
                <p className="text-xs text-neutral-300 mt-1">
                  Recorded in Supabase database under <span className="font-mono text-emerald-300">clipgenius_published_clips</span> for {publishedResult.platform.toUpperCase()}.
                </p>
              </div>

              <div className="rounded-xl bg-neutral-950/80 p-4 border border-neutral-800 text-left text-xs space-y-2">
                <div className="flex justify-between">
                  <span className="text-neutral-400">Published ID:</span>
                  <span className="font-mono text-white">{publishedResult.id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-400">Platform:</span>
                  <span className="font-bold text-violet-300 uppercase">{publishedResult.platform}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-400">Published At:</span>
                  <span className="text-neutral-200">{new Date(publishedResult.publishedAt).toLocaleString()}</span>
                </div>
                {renderJob?.downloadUrl && (
                  <div className="pt-2 flex justify-end">
                    <a
                      href={renderJob.downloadUrl}
                      download
                      className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 transition"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download Rendered MP4</span>
                    </a>
                  </div>
                )}
              </div>

              <div className="pt-2 flex justify-center gap-3">
                <button
                  type="button"
                  onClick={handleCopyBundle}
                  className="flex items-center gap-1.5 rounded-xl border border-neutral-700 bg-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-200 hover:bg-neutral-700 transition"
                >
                  {copiedBundle ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  <span>{copiedBundle ? 'Copied Bundle!' : 'Copy Social Metadata'}</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl bg-violet-600 px-4 py-2 text-xs font-bold text-white hover:bg-violet-500 transition"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            /* Publishing Configuration Form */
            <div className="space-y-5">
              {/* Target Platform Selector */}
              <div>
                <label className="block text-xs font-bold text-neutral-300 mb-2">
                  Destination Platform
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {[
                    { id: 'tiktok', name: 'TikTok', icon: '🎵' },
                    { id: 'shorts', name: 'Shorts', icon: '▶️' },
                    { id: 'reels', name: 'IG Reels', icon: '📸' },
                    { id: 'facebook', name: 'FB Reels', icon: '👥' },
                    { id: 'all', name: 'All 4', icon: '🌐' },
                  ].map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPlatform(p.id as any)}
                      className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-semibold transition ${
                        platform === p.id
                          ? 'border-violet-500 bg-violet-950/50 text-white ring-1 ring-violet-500'
                          : 'border-neutral-800 bg-neutral-950/40 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
                      }`}
                    >
                      <span className="text-base mb-1">{p.icon}</span>
                      <span>{p.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Render Status Notice */}
              <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3 flex items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-violet-400" />
                  <div>
                    <span className="font-semibold text-white">FFmpeg Render Status: </span>
                    {renderJob?.status === 'completed' ? (
                      <span className="text-emerald-400 font-bold">MP4 Ready ({renderJob.aspectRatio})</span>
                    ) : renderJob?.status === 'rendering' ? (
                      <span className="text-amber-400 font-bold">Rendering in Progress ({renderJob.progress}%)</span>
                    ) : (
                      <span className="text-neutral-400">Not rendered yet</span>
                    )}
                  </div>
                </div>

                {renderJob?.status === 'completed' ? (
                  <a
                    href={renderJob.downloadUrl}
                    download
                    className="flex items-center gap-1 rounded bg-neutral-800 px-2.5 py-1 text-[11px] font-semibold text-neutral-200 hover:bg-neutral-700"
                  >
                    <Download className="h-3 w-3" />
                    <span>Download</span>
                  </a>
                ) : onRequestRender ? (
                  <button
                    type="button"
                    onClick={() => onRequestRender(clip, '9:16')}
                    className="flex items-center gap-1 rounded bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-500"
                  >
                    <Cpu className="h-3 w-3" />
                    <span>Render 9:16 MP4</span>
                  </button>
                ) : null}
              </div>

              {/* Post Title & Hook */}
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-neutral-300 mb-1">
                    Post Title
                  </label>
                  <input
                    type="text"
                    value={postTitle}
                    onChange={(e) => setPostTitle(e.target.value)}
                    className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white focus:border-violet-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-neutral-300 mb-1">
                    On-Screen Hook Text
                  </label>
                  <input
                    type="text"
                    value={postHook}
                    onChange={(e) => setPostHook(e.target.value)}
                    className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white focus:border-violet-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Caption & Description */}
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">
                  Full Caption & Platform Description
                </label>
                <textarea
                  rows={3}
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white focus:border-violet-500 focus:outline-none"
                />
              </div>

              {/* Hashtags */}
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">
                  Platform Hashtags
                </label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {hashtags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-lg bg-violet-950/60 border border-violet-700/40 px-2 py-0.5 text-xs text-violet-300"
                    >
                      <span>{tag}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(tag)}
                        className="text-violet-400 hover:text-red-400 text-[10px]"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Add tag (e.g. #mindset)"
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddTag();
                      }
                    }}
                    className="flex-1 rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs text-white placeholder-neutral-500 focus:border-violet-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleAddTag}
                    className="rounded-xl border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-neutral-700"
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Optional Schedule */}
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1 flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-neutral-400" />
                  <span>Schedule Publication (Optional - Leave blank to publish instantly)</span>
                </label>
                <input
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  className="rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white focus:border-violet-500 focus:outline-none"
                />
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        {!publishedResult && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-t border-neutral-800 bg-neutral-950">
            <button
              type="button"
              onClick={handleCopyBundle}
              className="flex items-center gap-1.5 rounded-xl border border-neutral-700 bg-neutral-800 px-3.5 py-2 text-xs font-semibold text-neutral-200 hover:bg-neutral-700 transition"
            >
              {copiedBundle ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              <span>{copiedBundle ? 'Copied Bundle!' : 'Copy Social Bundle'}</span>
            </button>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl px-4 py-2 text-xs font-medium text-neutral-400 hover:text-white transition"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handlePublish}
                disabled={isPublishing}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 via-indigo-600 to-fuchsia-600 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-violet-600/30 hover:from-violet-500 hover:to-fuchsia-500 disabled:opacity-50 transition"
              >
                {isPublishing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-white" />
                    <span>Publishing Clip...</span>
                  </>
                ) : (
                  <>
                    <Share2 className="h-4 w-4" />
                    <span>{scheduledFor ? 'Schedule Clip' : 'Publish Clip to Supabase'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
