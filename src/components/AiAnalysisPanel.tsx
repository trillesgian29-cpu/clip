import React, { useState } from 'react';
import {
  Sparkles,
  Sliders,
  Flame,
  Clock,
  MessageSquare,
  Wand2,
  Loader2,
  CheckCircle2,
  ShieldAlert,
  Cpu,
  Coins,
  Activity,
  Layers,
  ChevronDown,
} from 'lucide-react';
import {
  VideoMetadata,
  ClipSuggestion,
  AiProviderMode,
  EditorialCurationStyle,
  AnalysisAuditReport,
} from '../types/index.ts';
import { api } from '../services/api.ts';

interface AiAnalysisPanelProps {
  video: VideoMetadata;
  onClipsGenerated: (clips: ClipSuggestion[], audit?: AnalysisAuditReport) => void;
  isAnalyzing: boolean;
  setIsAnalyzing: (analyzing: boolean) => void;
  lastAudit?: AnalysisAuditReport | null;
}

export const AiAnalysisPanel: React.FC<AiAnalysisPanelProps> = ({
  video,
  onClipsGenerated,
  isAnalyzing,
  setIsAnalyzing,
  lastAudit,
}) => {
  const [clipCount, setClipCount] = useState<number>(4);
  const [preferredProvider, setPreferredProvider] = useState<AiProviderMode>('auto_fallback');
  const [clipStyle, setClipStyle] = useState<EditorialCurationStyle>('viral_shorts');
  const [creatorDirection, setCreatorDirection] = useState('');
  const [videoCategory, setVideoCategory] = useState('Podcast & Interview');
  const [targetAudience, setTargetAudience] = useState('Short-form viewers (TikTok, Shorts, Reels)');
  const [chunkOffsetSeconds, setChunkOffsetSeconds] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [analysisStep, setAnalysisStep] = useState<string>('');
  const [localAudit, setLocalAudit] = useState<AnalysisAuditReport | null>(lastAudit || null);

  const handleStartAnalysis = async () => {
    setIsAnalyzing(true);
    setAnalysisStep('Pre-flight scan: Validating content & inspecting for color bars/black screens...');

    try {
      if (preferredProvider === 'strict_nemotron' || preferredProvider === 'auto_fallback') {
        setTimeout(() => setAnalysisStep('Contacting OpenRouter (nvidia/nemotron-3.5-super-vl:free)...'), 800);
        setTimeout(() => setAnalysisStep('Nemotron analyzing visual hook, retention curve & 7-dimension scoring...'), 2200);
      } else {
        setTimeout(() => setAnalysisStep('Analyzing with Google Gemini 3.8 Flash...'), 800);
      }

      const result = await api.analyzeVideo({
        videoId: video.id,
        preferredProvider,
        clipCount,
        clipStyle,
        editorialStyle: clipStyle,
        customPrompt: creatorDirection.trim() || undefined,
        creatorDirection: creatorDirection.trim() || undefined,
        transcript: transcript.trim() || undefined,
        videoCategory,
        targetAudience,
        targetPlatforms: ['TikTok', 'YouTube Shorts', 'Instagram Reels', 'Facebook Reels'],
        chunkName: `part_${Math.floor(chunkOffsetSeconds / 900) + 1}`,
        chunkOffsetSeconds,
      });

      setAnalysisStep('Applying content-first filters & validating timestamps...');

      if (result.audit) {
        setLocalAudit(result.audit);
      }

      setTimeout(() => {
        onClipsGenerated(result.clips, result.audit);
        setIsAnalyzing(false);
        setAnalysisStep('');
      }, 600);
    } catch (error) {
      console.error('AI analysis error:', error);
      alert(`AI Analysis failed: ${(error as Error).message}`);
      setIsAnalyzing(false);
      setAnalysisStep('');
    }
  };

  const auditToDisplay = lastAudit || localAudit;

  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/90 p-5 shadow-2xl space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-neutral-800">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <Cpu className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              Viral Moment Selection & AI Control
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 border border-emerald-500/30">
                NVIDIA Nemotron 3.5 + Gemini
              </span>
            </h3>
            <p className="text-xs text-neutral-400">
              Extract high-retention viral moments from "{video.originalName}" ({video.duration}s)
            </p>
          </div>
        </div>

        {/* Free Tier / OpenRouter Badge */}
        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-300">
            <Coins className="h-3.5 w-3.5 text-amber-400" />
            <span className="font-mono font-semibold text-emerald-400">$0.00</span>
            <span className="text-[10px] text-neutral-400">(Free Model)</span>
          </div>
        </div>
      </div>

      {/* AI Provider Mode Selector */}
      <div className="space-y-2">
        <label className="block text-xs font-semibold text-neutral-300">
          AI Provider Engine & Routing Mode
        </label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
          {/* Option 1: Auto Fallback */}
          <button
            type="button"
            onClick={() => setPreferredProvider('auto_fallback')}
            className={`text-left p-3 rounded-xl border transition flex flex-col justify-between ${
              preferredProvider === 'auto_fallback'
                ? 'border-violet-500 bg-violet-950/30 text-white ring-1 ring-violet-500'
                : 'border-neutral-800 bg-neutral-950/60 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
            }`}
          >
            <div className="flex items-center justify-between w-full mb-1">
              <span className="text-xs font-bold text-violet-300 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                Auto Fallback (Recommended)
              </span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-semibold">
                High Resilience
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-neutral-400">
              Uses NVIDIA Nemotron 3.5 Super VL primary; automatically falls back to Gemini 3.8 Flash if OpenRouter limits apply.
            </p>
          </button>

          {/* Option 2: Strict Nemotron */}
          <button
            type="button"
            onClick={() => setPreferredProvider('strict_nemotron')}
            className={`text-left p-3 rounded-xl border transition flex flex-col justify-between ${
              preferredProvider === 'strict_nemotron'
                ? 'border-emerald-500 bg-emerald-950/30 text-white ring-1 ring-emerald-500'
                : 'border-neutral-800 bg-neutral-950/60 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
            }`}
          >
            <div className="flex items-center justify-between w-full mb-1">
              <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-emerald-400" />
                Strict Nemotron 3.5 (Free)
              </span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold">
                Pure NVIDIA
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-neutral-400">
              nvidia/nemotron-3.5-super-vl:free via OpenRouter. Never switches models silently.
            </p>
          </button>

          {/* Option 3: Gemini Direct */}
          <button
            type="button"
            onClick={() => setPreferredProvider('gemini')}
            className={`text-left p-3 rounded-xl border transition flex flex-col justify-between ${
              preferredProvider === 'gemini'
                ? 'border-sky-500 bg-sky-950/30 text-white ring-1 ring-sky-500'
                : 'border-neutral-800 bg-neutral-950/60 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
            }`}
          >
            <div className="flex items-center justify-between w-full mb-1">
              <span className="text-xs font-bold text-sky-300 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-sky-400" />
                Gemini 3.8 Flash
              </span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 font-semibold">
                Google
              </span>
            </div>
            <p className="text-[11px] leading-relaxed text-neutral-400">
              Direct analysis with Gemini 3.8 Flash for ultra-fast structured transcript analysis.
            </p>
          </button>
        </div>
      </div>

      {/* Primary Configuration Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Desired Clip Count */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-3.5">
          <label className="block text-xs font-semibold text-neutral-300 mb-1.5 flex items-center justify-between">
            <span>Target Clip Count</span>
            <span className="font-mono text-emerald-400 font-bold px-2 py-0.5 rounded bg-emerald-500/10">
              {clipCount} clips
            </span>
          </label>
          <input
            type="range"
            min="2"
            max="8"
            step="1"
            value={clipCount}
            onChange={(e) => setClipCount(parseInt(e.target.value, 10))}
            className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
          />
          <div className="flex justify-between text-[10px] text-neutral-400 mt-2 font-mono">
            <span>2 Highlights</span>
            <span className="text-emerald-400 font-bold">4 Standard</span>
            <span>8 Deep Extraction</span>
          </div>
        </div>

        {/* Editorial Strategy */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-3.5">
          <label className="block text-xs font-semibold text-neutral-300 mb-1.5">
            Editorial Curation Style
          </label>
          <select
            value={clipStyle}
            onChange={(e) => setClipStyle(e.target.value as EditorialCurationStyle)}
            className="w-full rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
          >
            <option value="viral_shorts">🔥 Viral Shorts / TikTok (30–60s High Retention)</option>
            <option value="punchy_hooks">⚡ Punchy Hooks & Micro-Moments (15–30s Quick Hits)</option>
            <option value="educational">💡 Educational Nuggets & Pro Tips (20–60s Lessons)</option>
            <option value="storytelling">📖 Storytelling & Emotional Climax (25–60s Arcs)</option>
          </select>
          <p className="mt-1 text-[11px] text-neutral-400">
            {clipStyle === 'viral_shorts' && 'Enforces 30–60s complete stories and explanations with immediate tension and shareability.'}
            {clipStyle === 'punchy_hooks' && 'Enforces 15–30s rapid curiosity gaps and punchy payoffs.'}
            {clipStyle === 'educational' && 'Enforces 20–60s coherent lessons, demonstrations, and full context.'}
            {clipStyle === 'storytelling' && 'Enforces 25–60s multi-part narrative arcs preserving beginning, development, and payoff.'}
          </p>
        </div>
      </div>

      {/* Creator Direction Input */}
      <div>
        <label className="block text-xs font-semibold text-neutral-300 mb-1 flex items-center justify-between">
          <span>Creator Direction & Focus Keywords</span>
          <span className="text-[10px] text-neutral-400 font-normal">Optional</span>
        </label>
        <input
          type="text"
          placeholder="e.g. Prioritize discussions about scaling, ignore introductory chit-chat, highlight the architecture diagram..."
          value={creatorDirection}
          onChange={(e) => setCreatorDirection(e.target.value)}
          className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3.5 py-2.5 text-xs text-white placeholder-neutral-500 focus:border-emerald-500 focus:outline-none transition"
        />
      </div>

      {/* Advanced Drawer */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs font-medium text-neutral-400 hover:text-emerald-400 transition flex items-center gap-1.5"
        >
          <Sliders className="h-3.5 w-3.5" />
          <span>{showAdvanced ? 'Hide Advanced Settings' : 'Niche, Chunk Offset & Transcript Controls'}</span>
          <ChevronDown className={`h-3 w-3 transform transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
        </button>

        {showAdvanced && (
          <div className="mt-3 space-y-3 pt-3 border-t border-neutral-800">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">
                  Video Niche / Category
                </label>
                <select
                  value={videoCategory}
                  onChange={(e) => setVideoCategory(e.target.value)}
                  className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
                >
                  <option value="Podcast & Interview">🎙️ Podcast & Interview</option>
                  <option value="Tech, AI & Engineering">💻 Tech, AI & Engineering</option>
                  <option value="Business, Finance & Startups">📈 Business & Finance</option>
                  <option value="Gaming & Esports">🎮 Gaming & Streaming</option>
                  <option value="Comedy & Entertainment">🎭 Comedy & Reactions</option>
                  <option value="Educational & Science">🔬 Science & Education</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">
                  Chunk Start Offset (Seconds)
                </label>
                <input
                  type="number"
                  min="0"
                  max={Math.max(0, video.duration - 15)}
                  step="30"
                  value={chunkOffsetSeconds}
                  onChange={(e) => setChunkOffsetSeconds(parseInt(e.target.value, 10) || 0)}
                  className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs font-mono text-white focus:border-emerald-500 focus:outline-none"
                  placeholder="0 for start"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">
                Timestamped Transcript / Closed Captions (Optional)
              </label>
              <textarea
                rows={2}
                placeholder="[00:15] Host: 'What is the biggest shift in video?' [00:25] Guest: 'AI-driven semantic moment extraction.'..."
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white placeholder-neutral-500 focus:border-emerald-500 focus:outline-none font-mono"
              />
            </div>
          </div>
        )}
      </div>

      {/* Action Button & Live Progress */}
      <div>
        <button
          type="button"
          onClick={handleStartAnalysis}
          disabled={isAnalyzing}
          className="w-full flex items-center justify-center gap-2.5 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-indigo-600 px-5 py-3.5 text-sm font-bold text-white shadow-lg shadow-emerald-600/20 hover:from-emerald-500 hover:to-indigo-500 disabled:opacity-50 transition group"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-white" />
              <span>Analyzing Video with AI...</span>
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4 text-emerald-200 group-hover:rotate-12 transition-transform" />
              <span>Extract Viral Moments with {preferredProvider === 'strict_nemotron' ? 'Nemotron 3.5' : preferredProvider === 'gemini' ? 'Gemini 3.8' : 'AI Engine'}</span>
            </>
          )}
        </button>

        {isAnalyzing && analysisStep && (
          <div className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-neutral-950 border border-emerald-500/30 py-2.5 px-3 text-xs text-emerald-300">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            <span className="font-medium animate-pulse">{analysisStep}</span>
          </div>
        )}
      </div>

      {/* AI Provider Telemetry & Audit Card */}
      {auditToDisplay && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-950/80 p-4 space-y-3">
          <div className="flex items-center justify-between text-xs border-b border-neutral-800 pb-2">
            <span className="font-bold text-white flex items-center gap-1.5">
              <Activity className="h-4 w-4 text-emerald-400" />
              AI Execution Audit & Telemetry
            </span>
            <span className="text-[10px] text-neutral-400 font-mono">
              {new Date(auditToDisplay.analyzedAt).toLocaleTimeString()}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="p-2 rounded-lg bg-neutral-900 border border-neutral-800">
              <span className="text-[10px] text-neutral-400 block">Engine Used</span>
              <span className="font-semibold text-white capitalize">{auditToDisplay.actualProvider}</span>
            </div>
            <div className="p-2 rounded-lg bg-neutral-900 border border-neutral-800">
              <span className="text-[10px] text-neutral-400 block">Model ID</span>
              <span className="font-mono text-[11px] text-emerald-400 truncate block" title={auditToDisplay.actualModel}>
                {auditToDisplay.actualModel.split('/').pop()}
              </span>
            </div>
            <div className="p-2 rounded-lg bg-neutral-900 border border-neutral-800">
              <span className="text-[10px] text-neutral-400 block">Inference Cost</span>
              <span className="font-mono font-semibold text-emerald-400">
                ${(auditToDisplay.openRouterDetails?.cost || 0).toFixed(4)} (Free)
              </span>
            </div>
            <div className="p-2 rounded-lg bg-neutral-900 border border-neutral-800">
              <span className="text-[10px] text-neutral-400 block">Tokens (P / C / R)</span>
              <span className="font-mono text-[11px] text-neutral-300">
                {auditToDisplay.openRouterDetails?.promptTokens || '-'} / {auditToDisplay.openRouterDetails?.completionTokens || '-'} / {auditToDisplay.openRouterDetails?.reasoningTokens || '0'}
              </span>
            </div>
          </div>

          {/* JSON Parsing & Schema Health Badge Row */}
          {auditToDisplay.actualProvider === 'nemotron' && auditToDisplay.openRouterDetails && (
            <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg bg-neutral-900 border border-neutral-800 text-xs">
              <span className="text-[11px] font-medium text-neutral-400">Response Verification:</span>
              <span className={`px-2 py-0.5 rounded font-mono text-[11px] font-semibold ${
                auditToDisplay.openRouterDetails.jsonParsingStatus === 'json_parsed_successfully' || auditToDisplay.openRouterDetails.jsonParsingStatus === 'repaired_successfully'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              }`}>
                {auditToDisplay.openRouterDetails.jsonParsingStatus === 'json_parsed_successfully' && '✓ Valid JSON Schema'}
                {auditToDisplay.openRouterDetails.jsonParsingStatus === 'repaired_successfully' && '✓ Repaired via 1-Shot Schema Retry'}
                {auditToDisplay.openRouterDetails.jsonParsingStatus === 'schema_validation_failed' && '⚠ Schema Conformance Warning'}
                {auditToDisplay.openRouterDetails.jsonParsingStatus === 'model_invalid_json' && '✗ Invalid Model JSON'}
                {auditToDisplay.openRouterDetails.jsonParsingStatus === 'repair_failed' && '✗ JSON Repair Failed'}
                {!auditToDisplay.openRouterDetails.jsonParsingStatus && '✓ Verified'}
              </span>

              {auditToDisplay.openRouterDetails.repairAttempted && (
                <span className="px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-mono text-[10px]">
                  Retries: {auditToDisplay.openRouterDetails.repairRetryCount ?? 1}/1
                </span>
              )}

              {auditToDisplay.openRouterDetails.finishReason && (
                <span className={`px-2 py-0.5 rounded font-mono text-[10px] ${
                  auditToDisplay.openRouterDetails.finishReason === 'stop'
                    ? 'bg-neutral-800 text-neutral-300'
                    : 'bg-red-500/20 text-red-300 border border-red-500/30'
                }`}>
                  finish: {auditToDisplay.openRouterDetails.finishReason}
                </span>
              )}

              {auditToDisplay.openRouterDetails.latencyMs && (
                <span className="text-[10px] text-neutral-400 font-mono ml-auto">
                  Latency: {(auditToDisplay.openRouterDetails.latencyMs / 1000).toFixed(2)}s
                </span>
              )}
            </div>
          )}

          {auditToDisplay.fallbackUsed && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-950/30 border border-amber-500/30 text-xs text-amber-300">
              <ShieldAlert className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Transparent Fallback Triggered: </span>
                <span>{auditToDisplay.fallbackReason || 'Nemotron primary unavailable, auto-routed to Gemini 3.8 Flash.'}</span>
              </div>
            </div>
          )}

          {/* Editorial Policy & Transcript Evidence Verification Row */}
          {(auditToDisplay.editorialPolicy || auditToDisplay.transcriptVerification) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {auditToDisplay.editorialPolicy && (
                <div className="p-2.5 rounded-lg bg-neutral-900 border border-neutral-800">
                  <span className="text-[10px] text-neutral-400 block">Editorial Policy Enforced</span>
                  <span className="font-semibold text-white">
                    {auditToDisplay.editorialPolicy.label} ({auditToDisplay.editorialPolicy.idealRange})
                  </span>
                </div>
              )}
              {auditToDisplay.transcriptVerification && (
                <div className="p-2.5 rounded-lg bg-neutral-900 border border-neutral-800">
                  <span className="text-[10px] text-neutral-400 block">Evidence & Transcript Mode</span>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span
                      className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold ${
                        auditToDisplay.transcriptVerification.evidenceMode === 'combined'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                      }`}
                    >
                      {auditToDisplay.transcriptVerification.evidenceMode === 'combined'
                        ? 'Combined (Visual + Transcript)'
                        : auditToDisplay.transcriptVerification.evidenceMode === 'transcript_only'
                        ? 'Transcript Only'
                        : 'Visual-Only Analysis'}
                    </span>
                    <span className="text-[10px] text-neutral-400">
                      ({auditToDisplay.transcriptVerification.speechAnalysisClaimed ? 'Speech verified' : 'No speech transcript'})
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Insufficient Content Warning Banner */}
          {auditToDisplay.hasInsufficientContent && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-950/30 border border-amber-500/40 text-xs text-amber-200">
              <ShieldAlert className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block">Insufficient Coherent Content for Selected Style</span>
                <span className="text-[11px] text-amber-300/90">
                  {auditToDisplay.analysisSummary ||
                    `The source video does not contain a coherent segment satisfying the ${auditToDisplay.editorialPolicy?.idealRange || 'target'} requirement. No clips were fabricated.`}
                </span>
              </div>
            </div>
          )}

          {auditToDisplay.rejectedMoments && auditToDisplay.rejectedMoments.length > 0 && (
            <div className="p-2.5 rounded-lg bg-neutral-900 border border-neutral-800 text-xs text-neutral-400">
              <span className="font-semibold text-neutral-300 block mb-1">
                Editorial & Content Quality Filter Rejected {auditToDisplay.rejectedMoments.length} Candidate(s):
              </span>
              <ul className="list-disc list-inside space-y-1 text-[11px]">
                {auditToDisplay.rejectedMoments.map((rej, idx) => (
                  <li key={idx} className="leading-snug">
                    <span className="font-mono text-neutral-300">
                      [{rej.start.toFixed(1)}s–{rej.end.toFixed(1)}s]
                    </span>{' '}
                    {rej.title ? <strong className="text-neutral-200">{rej.title}: </strong> : null}
                    <span>{rej.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
