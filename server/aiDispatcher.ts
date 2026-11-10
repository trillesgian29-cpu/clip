import { analyzeWithNemotron, isOpenRouterConfigured, NEMOTRON_MODEL } from './nemotron.ts';
import { analyzeVideoWithGemini } from './gemini.ts';
import { ClipSuggestion } from '../src/types/index.ts';

export interface DispatcherOptions {
  preferredProvider?: 'nemotron' | 'gemini' | 'auto';
  sourceVideoId: string;
  sourcePath: string;
  filename: string;
  duration: number;
  clipCount?: number;
  clipStyle?: 'viral_shorts' | 'punchy_hooks' | 'educational' | 'storytelling';
  customPrompt?: string;
  transcript?: string;
  videoCategory?: string;
  targetAudience?: string;
  targetPlatforms?: string[];
  chunkName?: string;
  chunkOffsetSeconds?: number;
  privacyConsent?: boolean;
  previouslySelectedClips?: ClipSuggestion[];
}

export interface DispatcherResult {
  providerUsed: 'nemotron' | 'gemini';
  modelUsed: string;
  clips: ClipSuggestion[];
  stagesCompleted: string[];
}

/**
 * Dispatches video analysis to NVIDIA Nemotron 3.5 Super VL (OpenRouter) with Gemini fallback
 */
export async function dispatchVideoAnalysis(
  options: DispatcherOptions
): Promise<DispatcherResult> {
  const {
    preferredProvider = 'auto',
    sourceVideoId,
    sourcePath,
    filename,
    duration,
    clipCount = 3,
    clipStyle = 'viral_shorts',
    customPrompt,
    transcript,
    videoCategory = 'Podcast & Interview',
    targetAudience,
    targetPlatforms,
    chunkName = 'part_01',
    chunkOffsetSeconds = 0,
    privacyConsent = true,
    previouslySelectedClips = [],
  } = options;

  const stagesCompleted: string[] = ['video_inspected'];
  const hasOpenRouter = isOpenRouterConfigured();
  const hasGemini = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');

  // Provider decision logic
  let targetProvider = preferredProvider;
  if (targetProvider === 'auto') {
    if (hasOpenRouter) {
      targetProvider = 'nemotron';
    } else if (hasGemini) {
      targetProvider = 'gemini';
    } else {
      targetProvider = 'nemotron'; // Will trigger clear configuration error
    }
  }

  // 1. Attempt Nemotron 3.5 Super VL
  if (targetProvider === 'nemotron') {
    try {
      stagesCompleted.push('frames_extracted');
      stagesCompleted.push('nemotron_analyzing');

      const clips = await analyzeWithNemotron({
        sourceVideoId,
        sourcePath,
        filename,
        duration,
        chunkName,
        chunkOffsetSeconds,
        transcript,
        privacyConsent,
        category: videoCategory,
        targetPlatforms,
        previouslySelectedClips,
      });

      stagesCompleted.push('candidates_ranked');
      stagesCompleted.push('timestamps_validated');

      return {
        providerUsed: 'nemotron',
        modelUsed: NEMOTRON_MODEL,
        clips,
        stagesCompleted,
      };
    } catch (nemotronError) {
      console.warn('[AI Dispatcher] Nemotron analysis failed or unavailable:', (nemotronError as Error).message);

      // If Gemini is available and configured, fallback gracefully
      if (hasGemini) {
        console.log('[AI Dispatcher] Falling back to Gemini 3.8 Flash analysis...');
        stagesCompleted.push('gemini_fallback_initiated');

        try {
          const geminiClips = await analyzeVideoWithGemini({
            duration,
            filename,
            clipCount,
            clipStyle,
            customPrompt,
            transcript,
            videoCategory,
            targetAudience,
            targetPlatforms,
            chunkName,
            chunkOffsetSeconds,
            previouslySelectedClips,
          });

          stagesCompleted.push('gemini_analysis_completed');

          return {
            providerUsed: 'gemini',
            modelUsed: 'gemini-3.8-flash',
            clips: geminiClips.map((c) => ({
              ...c,
              sourceVideoId,
              thumbnailUrl: `/api/thumbnails/clip/${sourceVideoId}?t=${Math.round(c.startTime)}`,
              selected: true,
            })),
            stagesCompleted,
          };
        } catch (geminiError) {
          throw new Error(
            `Both Nemotron and Gemini analysis failed. Nemotron: ${(nemotronError as Error).message}. Gemini: ${(geminiError as Error).message}`
          );
        }
      }

      // No fallback available - report exact honest error without inventing timestamps
      throw nemotronError;
    }
  }

  // 2. Direct Gemini request
  if (targetProvider === 'gemini') {
    if (!hasGemini) {
      throw new Error(
        'Gemini analysis requested but GEMINI_API_KEY is not configured in the server environment.'
      );
    }

    stagesCompleted.push('gemini_analyzing');
    const clips = await analyzeVideoWithGemini({
      duration,
      filename,
      clipCount,
      clipStyle,
      customPrompt,
      transcript,
      videoCategory,
      targetAudience,
      targetPlatforms,
      chunkName,
      chunkOffsetSeconds,
      previouslySelectedClips,
    });

    stagesCompleted.push('candidates_ranked');
    stagesCompleted.push('timestamps_validated');

    return {
      providerUsed: 'gemini',
      modelUsed: 'gemini-3.8-flash',
      clips: clips.map((c) => ({
        ...c,
        sourceVideoId,
        thumbnailUrl: `/api/thumbnails/clip/${sourceVideoId}?t=${Math.round(c.startTime)}`,
        selected: true,
      })),
      stagesCompleted,
    };
  }

  throw new Error(`Invalid AI provider selected: ${targetProvider}`);
}
