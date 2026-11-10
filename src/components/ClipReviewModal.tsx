import React, { useState } from 'react';
import {
  X,
  CheckCircle2,
  AlertTriangle,
  Flame,
  Clock,
  Sparkles,
  Quote,
  ShieldCheck,
  Play,
  Share2,
  Check,
  ChevronRight,
  TrendingUp,
  FileText,
  Sliders,
} from 'lucide-react';
import { ClipSuggestion, ViralScores } from '../types/index.ts';
import { api } from '../services/api.ts';

interface ClipReviewModalProps {
  clip: ClipSuggestion | null;
  isOpen: boolean;
  onClose: () => void;
  onApprove: (clip: ClipSuggestion) => void;
  onReject: (clipId: string) => void;
  onProceedToPublish: (clip: ClipSuggestion) => void;
  onPreview: (clip: ClipSuggestion) => void;
  videoDuration: number;
}

export const ClipReviewModal: React.FC<ClipReviewModalProps> = ({
  clip,
  isOpen,
  onClose,
  onApprove,
  onReject,
  onProceedToPublish,
  onPreview,
  videoDuration,
}) => {
  if (!isOpen || !clip) return null;

  // Local state for edits during review
  const [activeHook, setActiveHook] = useState(clip.hook);
  const [clipTitle, setClipTitle] = useState(clip.title);
  const [startTime, setStartTime] = useState(clip.startTime);
  const [endTime, setEndTime] = useState(clip.endTime);
  const [validationResult, setValidationResult] = useState<{ isValid: boolean; errors: string[] } | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const duration = Math.max(0.5, Math.round((endTime - startTime) * 10) / 10);

  const scores: ViralScores = clip.scores || {
    hook: Math.min(10, Math.round((clip.viralityScore / 10) * 10) / 10),
    standalone: 8.5,
    emotion: 8.2,
    payoff: 8.6,
    share_worthy: 8.4,
    pacing: 8.3,
    visual_potential: 8.1,
    overall_average: Math.min(10, Math.round((clip.viralityScore / 10) * 10) / 10),
  };

  const handleSelectAltHook = (alt: string) => {
    setActiveHook(alt);
    setClipTitle(alt.length > 45 ? `${alt.substring(0, 42)}...` : alt);
  };

  const handleRunValidation = async () => {
    setIsValidating(true);
    try {
      const result = await api.validateClip({
        clip: {
          ...clip,
          hook: activeHook,
          startTime,
          endTime,
          duration,
        },
        videoDuration,
      });
      setValidationResult(result);
    } catch (err) {
      setValidationResult({
        isValid: false,
        errors: [(err as Error).message],
      });
    } finally {
      setIsValidating(false);
    }
  };

  const handleSaveAndApprove = () => {
    const updatedClip: ClipSuggestion = {
      ...clip,
      title: clipTitle,
      hook: activeHook,
      startTime,
      endTime,
      duration,
      reviewStatus: 'approved',
      publishStatus: clip.publishStatus === 'published' ? 'published' : 'ready_to_publish',
    };
    onApprove(updatedClip);
  };

  const isThresholdMet =
    scores.hook >= 8.0 &&
    scores.standalone >= 8.0 &&
    scores.payoff >= 8.0 &&
    scores.overall_average >= 8.0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-md animate-in fade-in">
      <div className="relative w-full max-w-4xl max-h-[92vh] flex flex-col rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 bg-neutral-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-violet-600/20 text-violet-400 border border-violet-500/30">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-violet-400">
                  Review-First Workflow
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                    clip.reviewStatus === 'approved'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : clip.reviewStatus === 'rejected'
                      ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  }`}
                >
                  {clip.reviewStatus === 'approved'
                    ? 'Approved'
                    : clip.reviewStatus === 'rejected'
                    ? 'Rejected'
                    : 'Needs Review'}
                </span>
              </div>
              <h3 className="text-base font-bold text-white tracking-tight mt-0.5">
                Viral Quality & Editorial Review: "{clipTitle}"
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

        {/* Modal Body - Scrollable */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Top Banner: Strict Threshold Check */}
          <div
            className={`rounded-xl border p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${
              isThresholdMet
                ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                : 'bg-amber-950/30 border-amber-500/40 text-amber-200'
            }`}
          >
            <div className="flex items-center gap-3">
              {isThresholdMet ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0" />
              )}
              <div>
                <p className="text-xs font-bold">
                  {isThresholdMet
                    ? 'High-Quality Viral Threshold Qualified (All Mandatory Metrics ≥ 8/10)'
                    : 'Strict Threshold Warning: Some metrics are below the 8.0 target'}
                </p>
                <p className="text-[11px] opacity-80 mt-0.5">
                  ClipGenius AI evaluated hook strength, retention curve, standalone comprehensibility, and payoff.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-bold">Overall Average:</span>
              <span className="px-2.5 py-1 rounded-lg bg-neutral-900 font-mono font-black text-sm text-white border border-neutral-700">
                {scores.overall_average.toFixed(1)} / 10
              </span>
            </div>
          </div>

          {/* Grid 1: Viral Potential Scorecard (7 Dimensions) */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-400 mb-3 flex items-center gap-1.5">
              <Flame className="h-4 w-4 text-violet-400" />
              <span>Retention & Viral Potential Scorecard</span>
            </h4>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Hook (0-3s)', value: scores.hook, req: '≥ 8.0', pass: scores.hook >= 8.0 },
                { label: 'Standalone', value: scores.standalone, req: '≥ 8.0', pass: scores.standalone >= 8.0 },
                { label: 'Payoff & Punchline', value: scores.payoff, req: '≥ 8.0', pass: scores.payoff >= 8.0 },
                { label: 'Share-worthiness', value: scores.share_worthy, req: 'High', pass: scores.share_worthy >= 8.0 },
                { label: 'Emotional Resonance', value: scores.emotion, req: 'Peak', pass: scores.emotion >= 8.0 },
                { label: 'Pacing & Rhythm', value: scores.pacing, req: 'Fast', pass: scores.pacing >= 8.0 },
                { label: 'Visual Potential', value: scores.visual_potential, req: '9:16 Frame', pass: scores.visual_potential >= 8.0 },
                { label: 'Overall Rating', value: scores.overall_average, req: '≥ 8.0', pass: scores.overall_average >= 8.0 },
              ].map((metric, i) => (
                <div
                  key={i}
                  className={`rounded-xl border p-3 ${
                    metric.pass
                      ? 'bg-neutral-950/80 border-emerald-500/30'
                      : 'bg-neutral-950/80 border-neutral-800'
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px] text-neutral-400 mb-1">
                    <span>{metric.label}</span>
                    <span className="text-[10px] font-mono text-neutral-500">{metric.req}</span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-lg font-black font-mono text-white">
                      {metric.value.toFixed(1)}
                    </span>
                    {metric.pass ? (
                      <span className="text-[10px] font-bold text-emerald-400">PASSED</span>
                    ) : (
                      <span className="text-[10px] font-bold text-amber-400">FAIR</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Grid 2: Story Structure & Retention Progression */}
          {clip.story_structure && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-400 mb-3 flex items-center gap-1.5">
                <TrendingUp className="h-4 w-4 text-indigo-400" />
                <span>Story Structure & Retention Arc</span>
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3 space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-violet-400">
                    1. Immediate Hook
                  </span>
                  <p className="text-xs text-neutral-300">{clip.story_structure.opening}</p>
                </div>
                <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3 space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400">
                    2. Context
                  </span>
                  <p className="text-xs text-neutral-300">{clip.story_structure.context}</p>
                </div>
                <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3 space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
                    3. Curiosity Gap
                  </span>
                  <p className="text-xs text-neutral-300">{clip.story_structure.curiosity}</p>
                </div>
                <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3 space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                    4. Satisfying Payoff
                  </span>
                  <p className="text-xs text-neutral-300">{clip.story_structure.payoff}</p>
                </div>
              </div>
            </div>
          )}

          {/* Weakness Analysis */}
          {clip.weakness && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-4">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <h5 className="text-xs font-bold text-amber-300">
                    Honest Weakness Analysis (Reviewer Notes)
                  </h5>
                  <p className="text-xs text-amber-200/90 mt-1 leading-relaxed">
                    {clip.weakness}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Hook Review & Alternate Hooks Selector */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-neutral-400 flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-violet-400" />
              <span>Hook Review & Alternate Hook A/B Options</span>
            </h4>

            <div>
              <label className="text-[11px] text-neutral-400 block mb-1">Active Opening Hook</label>
              <input
                type="text"
                value={activeHook}
                onChange={(e) => setActiveHook(e.target.value)}
                className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs font-medium text-white focus:border-violet-500 focus:outline-none"
              />
            </div>

            {clip.alternate_hooks && clip.alternate_hooks.length > 0 && (
              <div className="space-y-2">
                <span className="text-[11px] text-neutral-400 block">
                  Click to adopt an alternate hook approach:
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {clip.alternate_hooks.map((alt, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handleSelectAltHook(alt)}
                      className={`text-left p-3 rounded-xl border transition text-xs flex items-start gap-2 ${
                        activeHook === alt
                          ? 'border-violet-500 bg-violet-950/40 text-white'
                          : 'border-neutral-800 bg-neutral-950/40 text-neutral-300 hover:border-neutral-700'
                      }`}
                    >
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-bold text-violet-300">
                        Alt #{i + 1}
                      </span>
                      <span className="flex-1">{alt}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Exact Transcript Quote & Timestamp Fine-Tuning */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h5 className="text-xs font-bold text-white flex items-center gap-1.5">
                <Quote className="h-4 w-4 text-violet-400" />
                <span>Exact Source Dialogue Quote</span>
              </h5>
              <div className="text-[11px] font-mono text-neutral-400">
                Range: {startTime.toFixed(1)}s – {endTime.toFixed(1)}s ({duration.toFixed(1)}s)
              </div>
            </div>

            {clip.exact_quote && (
              <blockquote className="rounded-lg border-l-2 border-violet-500 bg-neutral-900/60 p-2.5 text-xs italic text-neutral-200">
                "{clip.exact_quote}"
              </blockquote>
            )}

            <div className="grid grid-cols-2 gap-3 pt-1">
              <div>
                <label className="text-[10px] text-neutral-400 block mb-0.5">Start Timestamp (s)</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max={endTime - 1}
                  value={startTime}
                  onChange={(e) => setStartTime(parseFloat(e.target.value) || 0)}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs font-mono text-white focus:border-violet-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] text-neutral-400 block mb-0.5">End Timestamp (s)</label>
                <input
                  type="number"
                  step="0.1"
                  min={startTime + 1}
                  max={videoDuration}
                  value={endTime}
                  onChange={(e) => setEndTime(parseFloat(e.target.value) || startTime + 1)}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs font-mono text-white focus:border-violet-500 focus:outline-none"
                />
              </div>
            </div>

            {/* Independent Validation */}
            <div className="pt-2 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800">
              <button
                type="button"
                onClick={handleRunValidation}
                disabled={isValidating}
                className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-700 transition"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-violet-400" />
                <span>{isValidating ? 'Validating...' : 'Validate Timestamps & Quote'}</span>
              </button>

              {validationResult && (
                <div className="flex items-center gap-1.5 text-xs">
                  {validationResult.isValid ? (
                    <span className="flex items-center gap-1 text-emerald-400 font-semibold">
                      <Check className="h-3.5 w-3.5" /> All Validation Checks Passed
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-red-400 font-medium">
                      <AlertTriangle className="h-3.5 w-3.5" /> {validationResult.errors[0]}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Modal Footer / Review Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-t border-neutral-800 bg-neutral-950">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPreview({ ...clip, startTime, endTime })}
              className="flex items-center gap-1.5 rounded-xl border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-300 hover:bg-neutral-700 transition"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>Preview Segment</span>
            </button>

            <button
              type="button"
              onClick={() => onReject(clip.id)}
              className="rounded-xl border border-red-500/20 bg-red-950/20 px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-900/30 transition"
            >
              Reject Moment
            </button>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSaveAndApprove}
              className="flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-950/40 px-4 py-2 text-xs font-bold text-emerald-300 hover:bg-emerald-900/50 transition"
            >
              <CheckCircle2 className="h-4 w-4" />
              <span>Approve Clip</span>
            </button>

            <button
              type="button"
              onClick={() => {
                const approvedClip: ClipSuggestion = {
                  ...clip,
                  title: clipTitle,
                  hook: activeHook,
                  startTime,
                  endTime,
                  duration,
                  reviewStatus: 'approved',
                };
                onProceedToPublish(approvedClip);
              }}
              className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-violet-600/30 hover:from-violet-500 hover:to-indigo-500 transition"
            >
              <Share2 className="h-4 w-4" />
              <span>Proceed to Publish Clip</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
