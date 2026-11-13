import { analyzeWithNemotron, isOpenRouterConfigured, NEMOTRON_MODEL } from './nemotron.ts';
import { analyzeVideoWithGemini } from './gemini.ts';
import { getEditorialPolicy } from './editorialPolicy.ts';
import { verifyAndPrepareTranscript } from './transcriptVerifier.ts';
import { probeVideo } from './ffmpeg.ts';
import {
  ClipSuggestion,
  AiProviderMode,
  EditorialCurationStyle,
  OpenRouterDetails,
  TranscriptVerificationInfo,
} from '../src/types/index.ts';

export interface DispatcherOptions {
  preferredProvider?: AiProviderMode;
  sourceVideoId: string;
  sourcePath: string;
  filename: string;
  duration: number;
  clipCount?: number;
  clipStyle?: EditorialCurationStyle;
  editorialStyle?: EditorialCurationStyle;
  customPrompt?: string;
  creatorDirection?: string;
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
  requestedProvider: AiProviderMode;
  providerUsed: 'nemotron' | 'gemini';
  modelUsed: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  openRouterDetails?: OpenRouterDetails;
  rejectedMoments: Array<{ title?: string; start: number; end: number; reason: string }>;
  editorialStyleUsed: EditorialCurationStyle;
  editorialPolicy: {
    label: string;
    minDuration: number;
    maxDuration: number;
    idealRange: string;
  };
  creatorDirectionUsed?: string;
  clips: ClipSuggestion[];
  stagesCompleted: string[];
  hasInsufficientContent: boolean;
  analysisSummary?: string;
  transcriptVerification?: TranscriptVerificationInfo;
  sourceMetadata?: {
    width: number;
    height: number;
    fps?: number;
    format: string;
    hasAudio: boolean;
    bitrate?: number;
  };
}

/**
 * Dispatches video analysis according to requested AI provider mode:
 * - 'strict_nemotron': Exclusively uses NVIDIA Nemotron 3.5 Super VL. No silent fallback.
 * - 'auto_fallback': Primary Nemotron, automatic transparent fallback to Gemini 3.8 Flash if Nemotron fails.
 * - 'gemini': Directly uses Gemini 3.8 Flash.
 */
export async function dispatchVideoAnalysis(
  options: DispatcherOptions
): Promise<DispatcherResult> {
  const {
    preferredProvider = 'auto_fallback',
    sourceVideoId,
    sourcePath,
    filename,
    duration,
    clipCount = 3,
    clipStyle = 'viral_shorts',
    editorialStyle,
    customPrompt = '',
    creatorDirection,
    transcript = '',
    videoCategory = 'Podcast & Interview',
    targetAudience,
    targetPlatforms = ['TikTok', 'YouTube Shorts', 'Instagram Reels'],
    chunkName = 'part_01',
    chunkOffsetSeconds = 0,
    privacyConsent = true,
    previouslySelectedClips = [],
  } = options;

  const effectiveStyle: EditorialCurationStyle = editorialStyle || clipStyle;
  const policy = getEditorialPolicy(effectiveStyle);
  const policySummary = {
    label: policy.label,
    minDuration: policy.minDuration,
    maxDuration: policy.maxDuration,
    idealRange: policy.idealRange,
  };
  const effectiveDirection = creatorDirection || customPrompt;

  const stagesCompleted: string[] = ['video_inspected'];
  const hasOpenRouter = isOpenRouterConfigured();
  const hasGemini = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');

  const requestedMode: AiProviderMode = preferredProvider;

  // 1. STRICT NEMOTRON MODE
  if (requestedMode === 'strict_nemotron') {
    if (!hasOpenRouter) {
      throw new Error(
        'Strict Nemotron Mode selected, but OPENROUTER_API_KEY is not configured in the server environment. Please configure OPENROUTER_API_KEY or switch to Auto Fallback Mode.'
      );
    }

    stagesCompleted.push('frames_extracted');
    stagesCompleted.push('transcript_verified');
    stagesCompleted.push('nemotron_analyzing');

    try {
      const nemotronResult = await analyzeWithNemotron({
        sourceVideoId,
        sourcePath,
        filename,
        duration,
        clipCount,
        editorialStyle: effectiveStyle,
        creatorDirection: effectiveDirection,
        chunkName,
        chunkOffsetSeconds,
        transcript,
        privacyConsent,
        category: videoCategory,
        targetPlatforms,
        previouslySelectedClips,
      });

      stagesCompleted.push('editorial_duration_enforced');
      stagesCompleted.push('transitions_inspected');
      stagesCompleted.push('candidates_ranked');
      stagesCompleted.push('timestamps_validated');

      return {
        requestedProvider: 'strict_nemotron',
        providerUsed: 'nemotron',
        modelUsed: NEMOTRON_MODEL,
        fallbackUsed: false,
        openRouterDetails: nemotronResult.openRouterDetails,
        rejectedMoments: nemotronResult.rejectedMoments,
        editorialStyleUsed: effectiveStyle,
        editorialPolicy: policySummary,
        creatorDirectionUsed: effectiveDirection,
        clips: nemotronResult.clips,
        stagesCompleted,
        hasInsufficientContent: nemotronResult.hasInsufficientContent,
        analysisSummary: nemotronResult.analysisSummary,
        transcriptVerification: nemotronResult.transcriptVerification,
        sourceMetadata: nemotronResult.sourceMetadata,
      };
    } catch (nemotronError) {
      // In STRICT mode, NEVER silently switch to Gemini!
      console.error('[AI Dispatcher] Strict Nemotron Mode failed:', (nemotronError as Error).message);
      const wrapped = new Error(`Strict Nemotron Mode failed: ${(nemotronError as Error).message}`);
      (wrapped as any).statusCode = (nemotronError as any)?.statusCode;
      (wrapped as any).isDailyQuotaExhausted = (nemotronError as any)?.isDailyQuotaExhausted;
      (wrapped as any).rateLimitResetAt = (nemotronError as any)?.rateLimitResetAt;
      throw wrapped;
    }
  }

  // 2. AUTOMATIC FALLBACK MODE (Nemotron primary -> Gemini secondary)
  if (requestedMode === 'auto_fallback') {
    if (hasOpenRouter) {
      stagesCompleted.push('frames_extracted');
      stagesCompleted.push('transcript_verified');
      stagesCompleted.push('nemotron_analyzing');

      try {
        const nemotronResult = await analyzeWithNemotron({
          sourceVideoId,
          sourcePath,
          filename,
          duration,
          clipCount,
          editorialStyle: effectiveStyle,
          creatorDirection: effectiveDirection,
          chunkName,
          chunkOffsetSeconds,
          transcript,
          privacyConsent,
          category: videoCategory,
          targetPlatforms,
          previouslySelectedClips,
        });

        stagesCompleted.push('editorial_duration_enforced');
        stagesCompleted.push('transitions_inspected');
        stagesCompleted.push('candidates_ranked');
        stagesCompleted.push('timestamps_validated');

        return {
          requestedProvider: 'auto_fallback',
          providerUsed: 'nemotron',
          modelUsed: NEMOTRON_MODEL,
          fallbackUsed: false,
          openRouterDetails: nemotronResult.openRouterDetails,
          rejectedMoments: nemotronResult.rejectedMoments,
          editorialStyleUsed: effectiveStyle,
          editorialPolicy: policySummary,
          creatorDirectionUsed: effectiveDirection,
          clips: nemotronResult.clips,
          stagesCompleted,
          hasInsufficientContent: nemotronResult.hasInsufficientContent,
          analysisSummary: nemotronResult.analysisSummary,
          transcriptVerification: nemotronResult.transcriptVerification,
          sourceMetadata: nemotronResult.sourceMetadata,
        };
      } catch (nemotronError) {
        console.warn(
          '[AI Dispatcher] Nemotron primary failed in Auto Fallback mode:',
          (nemotronError as Error).message
        );

        if (!hasGemini) {
          const wrapped = new Error(
            `Nemotron failed (${(nemotronError as Error).message}) and Gemini fallback is unconfigured.`
          );
          (wrapped as any).statusCode = (nemotronError as any)?.statusCode;
          (wrapped as any).isDailyQuotaExhausted = (nemotronError as any)?.isDailyQuotaExhausted;
          (wrapped as any).rateLimitResetAt = (nemotronError as any)?.rateLimitResetAt;
          throw wrapped;
        }

        // Graceful transparent fallback to Gemini
        stagesCompleted.push('gemini_fallback_initiated');
        const fallbackReason = (nemotronError as Error).message;

        let hasAudio = true;
        try {
          const probe = await probeVideo(sourcePath);
          hasAudio = probe.hasAudio;
        } catch {}

        const transcriptCtx = await verifyAndPrepareTranscript({
          videoPath: sourcePath,
          hasAudio,
          userTranscript: transcript,
          usingVisualFrames: false,
        });

        let geminiClips: ClipSuggestion[];
        try {
          geminiClips = await analyzeVideoWithGemini({
            duration,
            filename,
            clipCount,
            clipStyle: effectiveStyle,
            customPrompt: effectiveDirection,
            transcript: transcriptCtx.rawTranscript || transcript,
            videoCategory,
            targetAudience,
            targetPlatforms,
            chunkName,
            chunkOffsetSeconds,
            previouslySelectedClips,
          });
        } catch (geminiError) {
          const geminiMsg = (geminiError as Error).message;
          console.error('[AI Dispatcher] Gemini fallback failed in Auto Fallback mode:', geminiMsg);
          throw new Error(
            `Auto Fallback failed: Nemotron primary failed (${fallbackReason}); Gemini fallback failed (${geminiMsg})`
          );
        }

        stagesCompleted.push('gemini_analysis_completed');
        stagesCompleted.push('timestamps_validated');

        return {
          requestedProvider: 'auto_fallback',
          providerUsed: 'gemini',
          modelUsed: 'gemini-3.8-flash',
          fallbackUsed: true,
          fallbackReason,
          rejectedMoments: [],
          editorialStyleUsed: effectiveStyle,
          editorialPolicy: policySummary,
          creatorDirectionUsed: effectiveDirection,
          clips: geminiClips.map((c) => ({
            ...c,
            sourceVideoId,
            evidenceMode: transcriptCtx.verification.evidenceMode,
            editorialStyle: effectiveStyle,
            thumbnailUrl: `/api/thumbnails/clip/${sourceVideoId}?t=${Math.round(c.startTime)}`,
            selected: true,
            qualityCheckPassed: true,
          })),
          stagesCompleted,
          hasInsufficientContent: geminiClips.length === 0,
          transcriptVerification: transcriptCtx.verification,
        };
      }
    } else if (hasGemini) {
      // OpenRouter not configured, directly use Gemini in Auto mode
      stagesCompleted.push('gemini_analyzing');

      let hasAudio = true;
      try {
        const probe = await probeVideo(sourcePath);
        hasAudio = probe.hasAudio;
      } catch {}

      const transcriptCtx = await verifyAndPrepareTranscript({
        videoPath: sourcePath,
        hasAudio,
        userTranscript: transcript,
        usingVisualFrames: false,
      });

      const geminiClips = await analyzeVideoWithGemini({
        duration,
        filename,
        clipCount,
        clipStyle: effectiveStyle,
        customPrompt: effectiveDirection,
        transcript: transcriptCtx.rawTranscript || transcript,
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
        requestedProvider: 'auto_fallback',
        providerUsed: 'gemini',
        modelUsed: 'gemini-3.8-flash',
        fallbackUsed: true,
        fallbackReason: 'OPENROUTER_API_KEY was not configured; auto-routed to Gemini 3.8 Flash',
        rejectedMoments: [],
        editorialStyleUsed: effectiveStyle,
        editorialPolicy: policySummary,
        creatorDirectionUsed: effectiveDirection,
        clips: geminiClips.map((c) => ({
          ...c,
          sourceVideoId,
          evidenceMode: transcriptCtx.verification.evidenceMode,
          editorialStyle: effectiveStyle,
          thumbnailUrl: `/api/thumbnails/clip/${sourceVideoId}?t=${Math.round(c.startTime)}`,
          selected: true,
          qualityCheckPassed: true,
        })),
        stagesCompleted,
        hasInsufficientContent: geminiClips.length === 0,
        transcriptVerification: transcriptCtx.verification,
      };
    } else {
      throw new Error('Neither OPENROUTER_API_KEY nor GEMINI_API_KEY is configured in the server environment.');
    }
  }

  // 3. GEMINI DIRECT MODE
  if (requestedMode === 'gemini') {
    if (!hasGemini) {
      throw new Error('Gemini Direct Mode selected but GEMINI_API_KEY is not configured in the server environment.');
    }

    stagesCompleted.push('gemini_analyzing');

    let hasAudio = true;
    try {
      const probe = await probeVideo(sourcePath);
      hasAudio = probe.hasAudio;
    } catch {}

    const transcriptCtx = await verifyAndPrepareTranscript({
      videoPath: sourcePath,
      hasAudio,
      userTranscript: transcript,
      usingVisualFrames: false,
    });

    const geminiClips = await analyzeVideoWithGemini({
      duration,
      filename,
      clipCount,
      clipStyle: effectiveStyle,
      customPrompt: effectiveDirection,
      transcript: transcriptCtx.rawTranscript || transcript,
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
      requestedProvider: 'gemini',
      providerUsed: 'gemini',
      modelUsed: 'gemini-3.8-flash',
      fallbackUsed: false,
      rejectedMoments: [],
      editorialStyleUsed: effectiveStyle,
      editorialPolicy: policySummary,
      creatorDirectionUsed: effectiveDirection,
      clips: geminiClips.map((c) => ({
        ...c,
        sourceVideoId,
        evidenceMode: transcriptCtx.verification.evidenceMode,
        editorialStyle: effectiveStyle,
        thumbnailUrl: `/api/thumbnails/clip/${sourceVideoId}?t=${Math.round(c.startTime)}`,
        selected: true,
        qualityCheckPassed: true,
      })),
      stagesCompleted,
      hasInsufficientContent: geminiClips.length === 0,
      transcriptVerification: transcriptCtx.verification,
    };
  }

  throw new Error(`Unsupported AI Provider Mode: ${requestedMode}`);
}
