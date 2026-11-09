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
} from 'lucide-react';
import { VideoMetadata, ClipSuggestion } from '../types/index.ts';
import { api } from '../services/api.ts';

interface AiAnalysisPanelProps {
  video: VideoMetadata;
  onClipsGenerated: (clips: ClipSuggestion[]) => void;
  isAnalyzing: boolean;
  setIsAnalyzing: (analyzing: boolean) => void;
}

export const AiAnalysisPanel: React.FC<AiAnalysisPanelProps> = ({
  video,
  onClipsGenerated,
  isAnalyzing,
  setIsAnalyzing,
}) => {
  const [clipCount, setClipCount] = useState(4);
  const [clipStyle, setClipStyle] = useState<'viral_shorts' | 'punchy_hooks' | 'educational' | 'storytelling'>('viral_shorts');
  const [customPrompt, setCustomPrompt] = useState('');
  const [transcript, setTranscript] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [analysisStep, setAnalysisStep] = useState<string>('');

  const handleStartAnalysis = async () => {
    setIsAnalyzing(true);
    setAnalysisStep('Scanning video timeline & audio waveforms...');

    try {
      setTimeout(() => setAnalysisStep('Running Gemini 3.8 Flash hook detection & retention curves...'), 1200);
      setTimeout(() => setAnalysisStep('Calculating Virality Scores (1-100) and platform tags...'), 2400);

      const result = await api.analyzeVideo({
        videoId: video.id,
        clipCount,
        clipStyle,
        customPrompt: customPrompt.trim() || undefined,
        transcript: transcript.trim() || undefined,
      });

      setAnalysisStep('Curating multi-clip timestamps and metadata...');
      setTimeout(() => {
        onClipsGenerated(result.clips);
        setIsAnalyzing(false);
        setAnalysisStep('');
      }, 800);
    } catch (error) {
      console.error('AI analysis error:', error);
      alert(`AI Analysis failed: ${(error as Error).message}`);
      setIsAnalyzing(false);
      setAnalysisStep('');
    }
  };

  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/80 p-5 shadow-xl">
      <div className="flex items-center justify-between pb-4 border-b border-neutral-800">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-violet-600/20 text-violet-400 border border-violet-500/30">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              Gemini 3.8 Flash Viral Clip Studio
              <span className="rounded bg-violet-500/20 px-2 py-0.5 text-[10px] font-semibold text-violet-300">
                AI Curator
              </span>
            </h3>
            <p className="text-xs text-neutral-400">
              Extract high-retention 9:16 vertical clips from "{video.originalName}"
            </p>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Desired Clip Count */}
        <div>
          <label className="block text-xs font-medium text-neutral-300 mb-1.5 flex items-center justify-between">
            <span>Target Clip Count</span>
            <span className="font-mono text-violet-400 font-bold">{clipCount} clips</span>
          </label>
          <input
            type="range"
            min="2"
            max="8"
            step="1"
            value={clipCount}
            onChange={(e) => setClipCount(parseInt(e.target.value, 10))}
            className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-violet-500"
          />
          <div className="flex justify-between text-[10px] text-neutral-400 mt-1">
            <span>2 Highlights</span>
            <span>4 Recommended</span>
            <span>8 Deep Extraction</span>
          </div>
        </div>

        {/* Editorial Strategy */}
        <div>
          <label className="block text-xs font-medium text-neutral-300 mb-1.5">
            Editorial Curation Style
          </label>
          <select
            value={clipStyle}
            onChange={(e) => setClipStyle(e.target.value as any)}
            className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white focus:border-violet-500 focus:outline-none"
          >
            <option value="viral_shorts">🔥 Viral Shorts / TikTok (30-60s High Retention)</option>
            <option value="punchy_hooks">⚡ Punchy Hooks & Micro-Moments (15-30s Quick Hits)</option>
            <option value="educational">💡 Educational Nuggets & Pro Tips</option>
            <option value="storytelling">📖 Storytelling & Emotional Climax</option>
          </select>
        </div>
      </div>

      {/* Advanced Toggle */}
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-[11px] font-medium text-neutral-400 hover:text-violet-400 transition flex items-center gap-1"
        >
          <Sliders className="h-3 w-3" />
          <span>{showAdvanced ? 'Hide Custom Direction' : 'Customize Creator Direction & Transcript (Optional)'}</span>
        </button>

        {showAdvanced && (
          <div className="mt-3 space-y-3 pt-3 border-t border-neutral-800/80">
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">
                Custom Creator Prompt
              </label>
              <input
                type="text"
                placeholder="e.g. Focus on the debate about future tech, prioritize humorous moments..."
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white placeholder-neutral-500 focus:border-violet-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">
                Transcript / Closed Captions Snippet (Optional)
              </label>
              <textarea
                rows={2}
                placeholder="Paste key dialogue or quotes to guide hook extraction..."
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs text-white placeholder-neutral-500 focus:border-violet-500 focus:outline-none"
              />
            </div>
          </div>
        )}
      </div>

      {/* Action Button & Analysis Steps */}
      <div className="mt-5">
        <button
          type="button"
          onClick={handleStartAnalysis}
          disabled={isAnalyzing}
          className="w-full flex items-center justify-center gap-2.5 rounded-xl bg-gradient-to-r from-violet-600 via-indigo-600 to-fuchsia-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-violet-600/30 hover:from-violet-500 hover:to-fuchsia-500 disabled:opacity-50 transition group"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-white" />
              <span>Analyzing Video with Gemini...</span>
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4 text-violet-200 group-hover:rotate-12 transition-transform" />
              <span>Generate Viral Clips with Gemini AI</span>
            </>
          )}
        </button>

        {isAnalyzing && analysisStep && (
          <div className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-violet-950/40 border border-violet-500/30 py-2 px-3 text-xs text-violet-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
            <span className="font-medium animate-pulse">{analysisStep}</span>
          </div>
        )}
      </div>
    </div>
  );
};
