import fs from 'fs';
import { extractSampleFrames, probeVideo, ProbeResult, verifyDecodableRange } from './ffmpeg.ts';
import {
  precomputeVideoQualityContext,
  SegmentQualityValidationResult,
  validateSegmentQuality,
} from './contentQualityInspector.ts';
import { getEditorialPolicy, validateEditorialDuration } from './editorialPolicy.ts';
import {
  alignClipWithTranscriptSegments,
  probeIntervalAudioActivity,
  verifyAndPrepareTranscript,
  verifyExactQuoteMatchesInterval,
} from './transcriptVerifier.ts';
import {
  CandidateVerificationChecks,
  ClipSuggestion,
  ViralScores,
  OpenRouterDetails,
  EditorialCurationStyle,
  TranscriptVerificationInfo,
  VerificationStatus,
} from '../src/types/index.ts';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const NEMOTRON_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

export const CLIP_ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    hasInsufficientContent: { type: 'boolean' },
    analysisSummary: { type: 'string' },
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          hook: { type: 'string' },
          startTime: { type: 'number' },
          endTime: { type: 'number' },
          factualDescription: { type: 'string' },
          visualEvidence: { type: 'string' },
          audioEvidence: { type: 'string' },
          reason: { type: 'string' },
          confidence: { type: 'number' },
          uncertaintyNote: { type: 'string' },
          category: { type: 'string' },
          weakness: { type: 'string' },
          alternate_hooks: {
            type: 'array',
            items: { type: 'string' },
          },
          exact_quote: { type: 'string' },
          scores: {
            type: 'object',
            properties: {
              hookStrength: { type: 'number' },
              audienceCuriosity: { type: 'number' },
              informationalValue: { type: 'number' },
              storyFlow: { type: 'number' },
              standaloneContext: { type: 'number' },
              payoff: { type: 'number' },
              shareability: { type: 'number' },
            },
            required: [
              'hookStrength',
              'audienceCuriosity',
              'informationalValue',
              'storyFlow',
              'standaloneContext',
              'payoff',
              'shareability',
            ],
            additionalProperties: false,
          },
        },
        required: [
          'title',
          'hook',
          'startTime',
          'endTime',
          'factualDescription',
          'visualEvidence',
          'audioEvidence',
          'reason',
          'confidence',
          'uncertaintyNote',
          'category',
          'weakness',
          'scores',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['clips', 'hasInsufficientContent', 'analysisSummary'],
  additionalProperties: false,
};

export interface NemotronAnalyzeOptions {
  sourceVideoId: string;
  sourcePath: string;
  filename: string;
  duration: number; // seconds
  clipCount?: number;
  editorialStyle?: EditorialCurationStyle;
  creatorDirection?: string;
  chunkName?: string;
  chunkOffsetSeconds?: number;
  segmentDurationSeconds?: number;
  transcript?: string;
  privacyConsent?: boolean;
  category?: string;
  targetPlatforms?: string[];
  previouslySelectedClips?: ClipSuggestion[];
}

export interface NemotronParsedClip {
  title: string;
  hook: string;
  startTime: number;
  endTime: number;
  factualDescription?: string;
  visualEvidence?: string;
  audioEvidence?: string;
  reason: string;
  confidence: number;
  uncertaintyNote?: string;
  category: string;
  weakness: string;
  alternate_hooks?: string[];
  exact_quote?: string;
  scores: {
    hookStrength: number;
    audienceCuriosity: number;
    informationalValue: number;
    storyFlow: number;
    standaloneContext: number;
    payoff: number;
    shareability: number;
  };
}

export interface NemotronAnalysisResult {
  clips: ClipSuggestion[];
  rejectedMoments: Array<{ title?: string; start: number; end: number; reason: string }>;
  openRouterDetails: OpenRouterDetails;
  hasInsufficientContent: boolean;
  analysisSummary: string;
  transcriptVerification: TranscriptVerificationInfo;
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
 * Check if OpenRouter is configured on the server
 */
export function isOpenRouterConfigured(): boolean {
  const key = process.env.OPENROUTER_API_KEY;
  return Boolean(key && key.trim().length > 0 && key !== 'MY_OPENROUTER_API_KEY');
}

/**
 * Robust JSON extraction and sanitization function
 */
export function extractAndSanitizeJson(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();

  // Strip markdown code fences if present
  if (text.includes('```json')) {
    text = text.replace(/^[\s\S]*?```json\s*/i, '').replace(/\s*```[\s\S]*$/, '');
  } else if (text.includes('```')) {
    text = text.replace(/^[\s\S]*?```\s*/, '').replace(/\s*```$/, '');
  }

  text = text.trim();

  // Find outermost JSON object or array bounds
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
  } else if (firstBracket !== -1) {
    const lastBracket = text.lastIndexOf(']');
    if (lastBracket > firstBracket) {
      text = text.slice(firstBracket, lastBracket + 1);
    }
  }

  // Remove trailing commas before closing braces/brackets
  text = text.replace(/,\s*([}\]])/g, '$1');

  return text;
}

/**
 * Normalize and sanitize non-OK OpenRouter HTTP errors across both primary and 1-shot repair calls.
 * - Redacts `user_id` before logging or propagating messages.
 * - Distinguishes daily free-tier quota exhaustion (`openrouter_free_tier_daily`) from short-term RPM rate limits.
 */
export function buildOpenRouterHttpError(
  status: number,
  errorBody: string,
  contextLabel: 'primary' | 'repair' = 'primary'
): Error & { statusCode: number; isDailyQuotaExhausted?: boolean; rateLimitResetAt?: string } {
  let sanitizedBodyForLog = errorBody || '';
  let parsedErr: any = null;
  try {
    parsedErr = JSON.parse(errorBody);
    if (parsedErr && typeof parsedErr === 'object' && 'user_id' in parsedErr) {
      const clone = { ...parsedErr };
      delete clone.user_id;
      sanitizedBodyForLog = JSON.stringify(clone);
    }
  } catch {
    sanitizedBodyForLog = sanitizedBodyForLog.replace(/"user_id"\s*:\s*"[^"]*"/gi, '"user_id":"[redacted]"');
  }

  const label = contextLabel === 'repair' ? 'OpenRouter JSON repair' : 'OpenRouter';
  console.error(`[Nemotron VL] ${label} error HTTP ${status}:`, sanitizedBodyForLog.slice(0, 500));

  if (status === 429) {
    const headersMeta = parsedErr?.error?.metadata?.headers || {};
    const limitSource = String(parsedErr?.error?.metadata?.limit_source || '');
    const errMessage = String(parsedErr?.error?.message || sanitizedBodyForLog || '');
    const resetMs = Number(headersMeta['X-RateLimit-Reset']);
    const resetIso = !isNaN(resetMs) && resetMs > 0 ? new Date(resetMs).toISOString() : undefined;
    const limitTotal = headersMeta['X-RateLimit-Limit'];
    const limitRemaining = headersMeta['X-RateLimit-Remaining'];

    const isDailyQuotaExhausted =
      limitSource === 'openrouter_free_tier_daily' ||
      errMessage.includes('free-models-per-day') ||
      /per[- ]day|daily limit/i.test(errMessage);

    const detailMsg = isDailyQuotaExhausted
      ? `${label} free-tier daily quota exhausted (HTTP 429, openrouter_free_tier_daily${
          limitTotal ? `, ${limitRemaining ?? 0}/${limitTotal} remaining` : ''
        }${resetIso ? `, resets at ${resetIso}` : ''}). Please wait for the daily reset or switch to Gemini.`
      : `${label} rate limit reached (HTTP 429${resetIso ? `, resets at ${resetIso}` : ''}). Please wait a moment or use Gemini fallback.`;

    const err = new Error(detailMsg) as Error & {
      statusCode: number;
      isDailyQuotaExhausted?: boolean;
      rateLimitResetAt?: string;
    };
    err.statusCode = 429;
    err.isDailyQuotaExhausted = isDailyQuotaExhausted;
    err.rateLimitResetAt = resetIso;
    return err;
  }

  if (status === 401 || status === 403) {
    const err = new Error(
      `OpenRouter authentication failed (HTTP ${status}). Check OPENROUTER_API_KEY in environment.`
    ) as Error & { statusCode: number };
    err.statusCode = status;
    return err;
  }

  const prefix =
    contextLabel === 'repair'
      ? `OpenRouter JSON repair HTTP ${status}`
      : `Nemotron AI analysis failed at OpenRouter (HTTP ${status})`;
  const err = new Error(`${prefix}: ${sanitizedBodyForLog.slice(0, 150)}`) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}

/**
 * Single controlled JSON repair request via OpenRouter with JSON Schema constraint
 * Exactly 1 attempt. Never invent timestamps or hallucinations.
 */
export async function repairNemotronJsonWithOpenRouter(
  rawContent: string,
  errorMsg: string,
  apiKey: string
): Promise<{ repairedJson: any; latencyMs: number }> {
  console.log(`[Nemotron VL Repair] Initiating 1-shot JSON schema repair (reason: ${errorMsg})...`);
  const repairStart = Date.now();

  let response: Response;
  try {
    response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(45000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Connection: 'close',
        'HTTP-Referer': process.env.APP_URL || 'https://clipgenius.ai',
        'X-Title': 'ClipGenius AI Studio Repair Engine',
      },
      body: JSON.stringify({
        model: NEMOTRON_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a strict JSON syntax repair tool for ClipGenius AI. The previous model response failed JSON syntax validation. Repair syntax errors, unescaped quotes, trailing commas, or formatting issues. Retain all original timestamps, quotes, titles, and scoring numbers without hallucinating new values. Return ONLY the valid JSON object conforming strictly to the requested schema.',
          },
          {
            role: 'user',
            content: `Repair this model response into valid JSON conforming strictly to the schema:\n\n${rawContent.slice(0, 4000)}\n\nSyntax error was: ${errorMsg}`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'ClipAnalysisResponse',
            strict: true,
            schema: CLIP_ANALYSIS_JSON_SCHEMA,
          },
        },
        temperature: 0.0,
        reasoning: { effort: 'low' },
        max_tokens: 4500,
      }),
    });
  } catch (err) {
    const errObj = err as Error;
    if (errObj.name === 'TimeoutError' || errObj.name === 'AbortError') {
      throw new Error('OpenRouter JSON repair timed out after 45000ms');
    }
    throw new Error(`OpenRouter JSON repair network failure: ${errObj.message}`);
  }

  const latencyMs = Date.now() - repairStart;

  if (!response.ok) {
    const errText = await response.text();
    throw buildOpenRouterHttpError(response.status, errText, 'repair');
  }

  const data = await response.json();
  const repairedContent = data.choices?.[0]?.message?.content?.trim() || '';
  const sanitized = extractAndSanitizeJson(repairedContent);
  const parsed = JSON.parse(sanitized);

  return { repairedJson: parsed, latencyMs };
}

/**
 * Validate and normalize clip candidate schema WITHOUT altering or stretching raw timestamps.
 */
export function validateAndNormalizeCandidate(
  cand: any,
  sourceDuration: number,
  _segmentStart: number,
  _segmentEnd: number
): NemotronParsedClip | null {
  if (!cand || typeof cand !== 'object') return null;

  const startVal = cand.startTime ?? cand.start;
  const endVal = cand.endTime ?? cand.end;
  if (
    startVal === null ||
    startVal === undefined ||
    startVal === '' ||
    typeof startVal === 'boolean' ||
    endVal === null ||
    endVal === undefined ||
    endVal === '' ||
    typeof endVal === 'boolean'
  ) {
    console.warn('[Nemotron VL] Dropping candidate with missing/empty timestamps:', cand);
    return null;
  }

  const rawStart = Number(startVal);
  const rawEnd = Number(endVal);

  if (isNaN(rawStart) || isNaN(rawEnd) || !isFinite(rawStart) || !isFinite(rawEnd)) {
    console.warn('[Nemotron VL] Dropping candidate with non-numeric timestamps:', cand);
    return null;
  }

  // Preserve exact timestamps without silently modifying or extending them
  const startTime = Math.round(rawStart * 10) / 10;
  const endTime = Math.round(rawEnd * 10) / 10;

  if (startTime < 0 || endTime <= startTime || endTime > sourceDuration + 0.5) {
    console.warn('[Nemotron VL] Candidate timestamps out of source video bounds:', {
      startTime,
      endTime,
      sourceDuration,
    });
    return null;
  }

  const title = String(cand.title || '').trim();
  const hook = String(cand.hook || title).trim();
  const factualDescription =
    typeof cand.factualDescription === 'string' && cand.factualDescription.trim().length > 0
      ? cand.factualDescription.trim()
      : undefined;
  const visualEvidence =
    typeof cand.visualEvidence === 'string' && cand.visualEvidence.trim().length > 0
      ? cand.visualEvidence.trim()
      : undefined;
  const audioEvidence =
    typeof cand.audioEvidence === 'string' && cand.audioEvidence.trim().length > 0
      ? cand.audioEvidence.trim()
      : undefined;
  const uncertaintyNote =
    typeof cand.uncertaintyNote === 'string' && cand.uncertaintyNote.trim().length > 0
      ? cand.uncertaintyNote.trim()
      : undefined;
  const reason = typeof cand.reason === 'string' ? cand.reason.trim() : '';

  if (!title) {
    console.warn('[Nemotron VL] Dropping candidate with empty title:', cand);
    return null;
  }

  // Never fabricate a generic reason when neither reason nor factualDescription was supplied
  if (!reason && !factualDescription) {
    console.warn('[Nemotron VL] Dropping candidate with no factual description or selection reason:', cand);
    return null;
  }

  // Keep confidence strictly honest (0 if missing/non-numeric — never coerce to 0.88)
  let confidence = 0;
  if (cand.confidence !== undefined && cand.confidence !== null && cand.confidence !== '') {
    const numConf = Number(cand.confidence);
    if (!isNaN(numConf) && isFinite(numConf)) {
      confidence = numConf > 1 && numConf <= 100 ? numConf / 100 : numConf;
      confidence = Math.round(Math.min(1.0, Math.max(0.0, confidence)) * 100) / 100;
    }
  }

  const category = String(cand.category || 'General').trim();
  const weakness = String(cand.weakness || 'Unverified boundary pacing — review before publishing.').trim();

  // Normalize scores (allow 0-1 scale or 0-10 scale)
  const rawScores = cand.scores || {};
  const normalizeScoreVal = (v: any, fallback: number) => {
    const num = Number(v);
    if (isNaN(num)) return fallback;
    if (num <= 1.0 && num > 0) return Math.round(num * 100) / 10;
    return Math.min(10, Math.max(1, Math.round(num * 10) / 10));
  };

  const scores = {
    hookStrength: normalizeScoreVal(rawScores.hookStrength ?? rawScores.hook, 7.5),
    audienceCuriosity: normalizeScoreVal(rawScores.audienceCuriosity, 7.5),
    informationalValue: normalizeScoreVal(rawScores.informationalValue ?? rawScores.emotion, 7.5),
    storyFlow: normalizeScoreVal(rawScores.storyFlow, 7.5),
    standaloneContext: normalizeScoreVal(rawScores.standaloneContext ?? rawScores.standalone, 7.5),
    payoff: normalizeScoreVal(rawScores.payoff, 7.5),
    shareability: normalizeScoreVal(rawScores.shareability ?? rawScores.share_worthy, 7.5),
  };

  const alternate_hooks = Array.isArray(cand.alternate_hooks)
    ? cand.alternate_hooks.map((h: any) => String(h).trim()).filter(Boolean)
    : undefined;

  const exact_quote = cand.exact_quote ? String(cand.exact_quote).trim() : undefined;

  return {
    title,
    hook: hook || title,
    startTime,
    endTime,
    factualDescription,
    visualEvidence,
    audioEvidence,
    reason: reason || factualDescription || '',
    confidence,
    uncertaintyNote,
    category,
    weakness,
    alternate_hooks,
    exact_quote,
    scores,
  };
}

/**
 * Combine uniform timeline anchors with adaptive frames immediately after detected scene transitions.
 */
export function buildAdaptiveFrameTimestamps(
  segmentStart: number,
  segmentEnd: number,
  sceneTransitions: number[],
  maxFrames: number = 18
): number[] {
  const effectiveDuration = Math.max(0, segmentEnd - segmentStart);
  const baseCount =
    effectiveDuration <= 180
      ? Math.min(12, Math.max(6, Math.ceil(effectiveDuration / 12)))
      : Math.min(14, Math.max(8, Math.floor(effectiveDuration / 45)));
  const step = effectiveDuration / (baseCount + 1);
  const candidates: number[] = [];

  for (let i = 1; i <= baseCount; i++) {
    candidates.push(Math.round((segmentStart + i * step) * 10) / 10);
  }

  for (const cut of sceneTransitions) {
    if (cut > segmentStart + 0.5 && cut < segmentEnd - 0.8) {
      candidates.push(Math.round(Math.min(segmentEnd - 0.3, cut + 0.8) * 10) / 10);
    }
  }

  candidates.sort((a, b) => a - b);

  // Deduplicate frames that are too close (< 2.0s) while keeping within maxFrames budget
  const merged: number[] = [];
  for (const ts of candidates) {
    if (merged.length === 0 || ts - merged[merged.length - 1] >= 2.0) {
      merged.push(ts);
    }
    if (merged.length >= maxFrames) break;
  }

  return merged;
}

/**
 * Independently verify candidate grounding against inspected video/audio/transcript evidence.
 * Never marks a candidate 'verified' merely because JSON parsed!
 */
export function evaluateCandidateVerification(params: {
  candidate: NemotronParsedClip;
  qualityCheck: SegmentQualityValidationResult;
  isDecodable: boolean;
  editorialDurationValid: boolean;
  hasAudio: boolean;
  intervalAudio: { audioActive: boolean; meanVolumeDb?: number; maxVolumeDb?: number };
  transcriptAvailable: boolean;
  transcriptSegmentText?: string;
  boundaryAdjusted: boolean;
}): {
  accepted: boolean;
  verificationStatus: VerificationStatus;
  uncertaintyNote?: string;
  rejectionReason?: string;
  checks: CandidateVerificationChecks;
} {
  const {
    candidate,
    qualityCheck,
    isDecodable,
    editorialDurationValid,
    hasAudio,
    intervalAudio,
    transcriptAvailable,
    transcriptSegmentText,
    boundaryAdjusted,
  } = params;

  const visualMotionDetected = qualityCheck.visualMotionDetected !== false;
  const quoteCheck = transcriptAvailable
    ? verifyExactQuoteMatchesInterval(candidate.exact_quote, transcriptSegmentText)
    : { matches: true, overlapRatio: 1 };

  const checks: CandidateVerificationChecks = {
    boundsValid: qualityCheck.isValid,
    decodable: isDecodable,
    visualDetailValid: qualityCheck.isValid,
    visualMotionDetected,
    audioIntervalActive: hasAudio ? intervalAudio.audioActive : undefined,
    transcriptAligned: transcriptAvailable ? Boolean(transcriptSegmentText) && quoteCheck.matches : false,
    editorialDurationValid,
    confidenceReported: candidate.confidence > 0,
  };

  if (!qualityCheck.isValid) {
    return {
      accepted: false,
      verificationStatus: 'rejected',
      rejectionReason: qualityCheck.rejectionReason || 'Failed visual/transition quality check.',
      checks,
    };
  }

  if (!isDecodable) {
    return {
      accepted: false,
      verificationStatus: 'rejected',
      rejectionReason: 'Video frames could not be decoded cleanly by FFmpeg in this timestamp range.',
      checks,
    };
  }

  if (!editorialDurationValid) {
    return {
      accepted: false,
      verificationStatus: 'rejected',
      rejectionReason: 'Clip duration failed editorial duration policy after verification.',
      checks,
    };
  }

  if (candidate.confidence > 0 && candidate.confidence < 0.45) {
    return {
      accepted: false,
      verificationStatus: 'rejected',
      rejectionReason: `Model confidence too low (${(candidate.confidence * 100).toFixed(0)}%) to justify selection.`,
      checks,
    };
  }

  if (!visualMotionDetected && (!hasAudio || !intervalAudio.audioActive)) {
    return {
      accepted: false,
      verificationStatus: 'rejected',
      rejectionReason: 'Static frozen frames with no visual progression and no active audio in candidate interval.',
      checks,
    };
  }

  if (transcriptAvailable && candidate.exact_quote && !quoteCheck.matches) {
    return {
      accepted: false,
      verificationStatus: 'rejected',
      rejectionReason: quoteCheck.reason || 'Exact spoken quote failed transcript alignment in this timestamp window.',
      checks,
    };
  }

  if (
    !transcriptAvailable &&
    !candidate.visualEvidence &&
    !candidate.factualDescription &&
    candidate.exact_quote &&
    candidate.exact_quote.length > 20
  ) {
    return {
      accepted: false,
      verificationStatus: 'rejected',
      rejectionReason: 'Candidate claimed spoken quote without any transcript or visual evidence backing.',
      checks,
    };
  }

  const uncertainties: string[] = [];
  if (candidate.confidence === 0) {
    uncertainties.push('Model omitted explicit numeric confidence score.');
  } else if (candidate.confidence < 0.7) {
    uncertainties.push(`Moderate AI confidence (${(candidate.confidence * 100).toFixed(0)}%).`);
  }

  if (!candidate.factualDescription || !candidate.visualEvidence) {
    uncertainties.push('Detailed factual description or visual evidence notes were incomplete.');
  }

  if (boundaryAdjusted) {
    uncertainties.push('Timestamps were adjusted around blank fades/scene transitions; preview range recommended.');
  }

  if (!visualMotionDetected && hasAudio && intervalAudio.audioActive) {
    uncertainties.push('Minimal visual pixel motion detected across interval (relies primarily on audio track).');
  }

  if (hasAudio && !intervalAudio.audioActive) {
    uncertainties.push('Audio track is silent or near-silent (<= -65 dB) within this timestamp range.');
  }

  if (hasAudio && !transcriptAvailable) {
    uncertainties.push('No verified transcript or subtitle track available; speech claims unverified.');
  }

  const normalizedModelNote = candidate.uncertaintyNote?.trim();
  if (
    normalizedModelNote &&
    !/^(none|n\/a|no uncertainty|high certainty|fully verified)$/i.test(normalizedModelNote)
  ) {
    uncertainties.push(normalizedModelNote);
  }

  const verificationStatus: VerificationStatus = uncertainties.length === 0 ? 'verified' : 'uncertain';
  return {
    accepted: true,
    verificationStatus,
    uncertaintyNote: uncertainties.length > 0 ? uncertainties.join(' ') : undefined,
    checks,
  };
}

/**
 * Compute Jaccard similarity between two text strings to catch repeated variations of the same idea
 */
function computeTopicSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Analyze video using NVIDIA Nemotron 3.5 Super VL via OpenRouter
 * Enforces Structured JSON Output, Editorial Curation Durations,
 * Transcript Verification, Transition-Aware Filtering, and Distinct Multi-Candidate Discovery.
 */
export async function analyzeWithNemotron(
  options: NemotronAnalyzeOptions
): Promise<NemotronAnalysisResult> {
  const {
    sourceVideoId,
    sourcePath,
    filename,
    duration,
    clipCount = 4,
    editorialStyle = 'viral_shorts',
    creatorDirection = '',
    chunkName = 'part_01',
    chunkOffsetSeconds = 0,
    segmentDurationSeconds = 900,
    transcript = '',
    privacyConsent = true,
    category = 'General',
    targetPlatforms = ['TikTok', 'YouTube Shorts', 'Instagram Reels'],
    previouslySelectedClips = [],
  } = options;

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey || apiKey === 'MY_OPENROUTER_API_KEY') {
    throw new Error(
      'NVIDIA Nemotron 3.5 Super VL requires OPENROUTER_API_KEY. Configure OPENROUTER_API_KEY in the server environment to enable AI video understanding.'
    );
  }

  if (!privacyConsent) {
    throw new Error(
      'Privacy Gate: External vision analysis requires user confirmation regarding OpenRouter third-party data processing terms.'
    );
  }

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source video file does not exist at ${sourcePath}`);
  }

  const policy = getEditorialPolicy(editorialStyle);

  // 1. Segment Window
  const segmentStart = Math.max(0, chunkOffsetSeconds);
  const segmentEnd = Math.min(duration, segmentStart + segmentDurationSeconds);
  const effectiveSegmentDuration = segmentEnd - segmentStart;

  if (effectiveSegmentDuration < 7) {
    throw new Error(
      `Video segment duration (${effectiveSegmentDuration.toFixed(1)}s) is too short for clip extraction (min 7s)`
    );
  }

  // 2. Probe full container metadata + audio & verify transcript honestly (never fabricated)
  let sourceProbe: ProbeResult = {
    duration,
    width: 1920,
    height: 1080,
    format: 'mp4',
    fps: 30,
    hasAudio: true,
  };
  try {
    sourceProbe = await probeVideo(sourcePath);
  } catch {
    // Keep conservative defaults if metadata probe throws
  }
  const hasAudio = sourceProbe.hasAudio;

  const transcriptCtx = await verifyAndPrepareTranscript({
    videoPath: sourcePath,
    hasAudio,
    userTranscript: transcript,
    usingVisualFrames: true,
  });

  // 3. Precompute video blackouts & scene transitions once
  const precomputedQuality = await precomputeVideoQualityContext(sourcePath);

  // 4. Adaptive Full-Video Frame Sampling (uniform anchors + detected scene-transition anchors)
  const frameTimestamps = buildAdaptiveFrameTimestamps(
    segmentStart,
    segmentEnd,
    precomputedQuality.sceneTransitions,
    18
  );

  console.log(
    `[Nemotron VL] Extracting ${frameTimestamps.length} adaptive frames across [${segmentStart}s - ${segmentEnd}s] for "${filename}" (${policy.label}, target ${policy.idealRange})...`
  );
  const extractedFrames = await extractSampleFrames(sourcePath, frameTimestamps, 448);

  if (extractedFrames.length === 0) {
    throw new Error(
      'Failed to extract representative video frames via FFmpeg. Verify source video contains decodable video streams.'
    );
  }

  // 5. Align sampled frame timestamps with transcript segments if available
  const frameDescriptions = extractedFrames.map((f, idx) => {
    const mm = Math.floor(f.timestamp / 60);
    const ss = Math.round(f.timestamp % 60);
    let speechNearFrame = '';
    if (transcriptCtx.segments.length > 0) {
      const nearby = transcriptCtx.segments.filter(
        (s) => s.endTime >= f.timestamp - 6 && s.startTime <= f.timestamp + 6
      );
      if (nearby.length > 0) {
        speechNearFrame = ` | Speech: "${nearby.map((n) => n.text).join(' ').slice(0, 180)}"`;
      }
    }
    return `[Sample Frame #${idx + 1} at ${f.timestamp.toFixed(1)}s (${mm}m ${ss}s)${speechNearFrame}]`;
  });

  const sceneMarkerText =
    precomputedQuality.sceneTransitions.length > 0
      ? precomputedQuality.sceneTransitions
          .filter((t) => t >= segmentStart && t <= segmentEnd)
          .slice(0, 20)
          .map((t) => `${t.toFixed(1)}s`)
          .join(', ')
      : 'No abrupt cuts detected';

  const prevClipsText =
    previouslySelectedClips.length > 0
      ? previouslySelectedClips
          .map((c) => `- "${c.title}" [${c.startTime}s - ${c.endTime}s]`)
          .join('\n')
      : 'None yet';

  const transcriptSection = transcriptCtx.verification.transcriptAvailable
    ? `VERIFIED TIMESTAMPED TRANSCRIPT (${transcriptCtx.verification.transcriptSource}):
${transcriptCtx.rawTranscript.slice(0, 5000)}`
    : `TRANSCRIPT STATUS: NO SPEECH TRANSCRIPT AVAILABLE (${transcriptCtx.verification.notes}). Rely strictly on visual frames and on-screen text. Do NOT invent or claim spoken quotes that are not visible in frames.`;

  const systemPrompt = `You are NVIDIA Nemotron 3.5 Super VL, a world-class video intelligence, narrative comprehension, and viral retention analyzer.
Your mission is to analyze the entire video timeline and identify ONLY genuinely valuable, coherent, distinct short-form clips grounded strictly in observed source video evidence and matching the user's Editorial Curation Style.

MANDATORY SOURCE-GROUNDING & EDITORIAL RULES:
1. SELECTED STYLE: ${policy.label.toUpperCase()}
   - REQUIRED DURATION RANGE: ${policy.minDuration} to ${policy.maxDuration} seconds (endTime - startTime MUST satisfy ${policy.minDuration} <= duration <= ${policy.maxDuration}).
   - ${policy.guidance}
   - NEVER return a 7-second or short fragment when ${policy.minDuration}-${policy.maxDuration}s is required.
   - Editorial style & Creator Direction guide selection among GENUINE moments ONLY — NEVER invent or pad unsupported clips just to reach target count.
   - If the source video does NOT contain a sufficiently long coherent segment (${policy.minDuration}s+), set "hasInsufficientContent": true, return an empty "clips": [] array, and explain why in "analysisSummary".
2. MULTIPLE CANDIDATE DISCOVERY:
   - Search the ENTIRE timeline (${segmentStart.toFixed(1)}s to ${segmentEnd.toFixed(1)}s) to find up to ${clipCount} DISTINCT, non-overlapping moments covering different ideas or chapters.
   - Avoid returning repeated variations of the same topic or overlapping timestamps.
   - Return fewer than ${clipCount} clips (or 0) if fewer genuine moments exist. Never force filler clips.
3. SCENE-TRANSITION & QUALITY FILTERING:
   - Reject SMPTE color bars, EBU color bars, test patterns, pitch-black dead screens, or frozen technical failures.
   - Normal editing transitions or brief chapter cuts between valid topic frames are acceptable if continuity holds, or adjust start/end cleanly to align with complete topic boundaries.
4. STRUCTURED EVIDENCE & HONEST UNCERTAINTY:
   - Provide concrete factualDescription (what literally happens in this interval), visualEvidence (specific visual subjects/text/changes seen in frames), and audioEvidence (exact spoken lines from transcript, or "Visual-only: no verified transcript" when absent).
   - Provide honest confidence (0.0 to 1.0) and uncertaintyNote explaining any gap (e.g., sparse frames, no transcript, mid-thought cut). Set uncertaintyNote to "None" only if evidence across the interval is complete and unambiguous.
   - Do NOT invent timestamps outside [${segmentStart.toFixed(1)}, ${segmentEnd.toFixed(1)}].
   - If no transcript was supplied, leave exact_quote empty or cite ONLY exact text visible on-screen.
5. Output ONLY valid JSON conforming strictly to the schema.`;

  const userPromptText = `
VIDEO INFORMATION:
- Title: "${filename}"
- Category: "${category}"
- Inspected Source Properties: ${sourceProbe.width}x${sourceProbe.height} @ ${sourceProbe.fps || 30}fps (${sourceProbe.format}), Audio Track: ${hasAudio ? (transcriptCtx.verification.audioActive ? 'Active audio present' : 'Audio track present (low/silent signal)') : 'No audio stream'}
- Segment Range: ${segmentStart.toFixed(1)}s to ${segmentEnd.toFixed(1)}s (Total Video Duration: ${duration.toFixed(1)}s)
- Target Platforms: ${targetPlatforms.join(', ')}
- Editorial Curation Style: ${policy.style} (${policy.label}) — STRICT DURATION: ${policy.minDuration}s to ${policy.maxDuration}s
- Detected Scene Cuts: ${sceneMarkerText}
${creatorDirection ? `- Creator Direction: "${creatorDirection}"` : ''}

${transcriptSection}

PREVIOUSLY SELECTED MOMENTS (DO NOT DUPLICATE OR OVERLAP):
${prevClipsText}

VISUAL TIMELINE FRAMES (${extractedFrames.length} adaptive frames sampled across entire video):
${frameDescriptions.join('\n')}

INSTRUCTIONS:
Identify up to ${clipCount} distinct, evidence-grounded moments across the full timeline that strictly satisfy ${policy.minDuration}s–${policy.maxDuration}s duration and "${policy.label}" curation.
Score each candidate on 7 dimensions (1.0 to 10.0): hookStrength, audienceCuriosity, informationalValue, storyFlow, standaloneContext, payoff, shareability.
`;

  // Multimodal payload
  const contentParts: any[] = [{ type: 'text', text: userPromptText }];
  for (const frame of extractedFrames) {
    contentParts.push({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${frame.base64}`,
      },
    });
  }

  // 6. Send structured output request to OpenRouter (85s per attempt; max 1 transient network/502-504 retry)
  console.log(`[Nemotron VL] Dispatching structured JSON request to OpenRouter (${NEMOTRON_MODEL})...`);
  const startTimeMs = Date.now();
  const OPENROUTER_ATTEMPT_TIMEOUT_MS = 85000;
  const requestBody = JSON.stringify({
    model: NEMOTRON_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: contentParts },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'ClipAnalysisResponse',
        strict: true,
        schema: CLIP_ANALYSIS_JSON_SCHEMA,
      },
    },
    temperature: 0.15,
    reasoning: { effort: 'low' },
    max_tokens: 8000,
  });

  let response!: Response;
  let responseData: any;
  let lastTransientError: Error | null = null;
  let networkRetryCount = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const attemptStartMs = Date.now();
    let fetchedResponse: Response;
    try {
      fetchedResponse = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(OPENROUTER_ATTEMPT_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Connection: 'close',
          'HTTP-Referer': process.env.APP_URL || 'https://clipgenius.ai',
          'X-Title': 'ClipGenius AI Studio',
        },
        body: requestBody,
      });
    } catch (networkErr) {
      const errObj = networkErr as Error;
      const errCode = (errObj as any)?.cause?.code || '';
      const isTransientNetworkOrTimeout =
        errObj.name === 'TimeoutError' ||
        errObj.name === 'AbortError' ||
        errCode === 'ECONNRESET' ||
        errCode === 'ETIMEDOUT' ||
        errCode === 'UND_ERR_SOCKET' ||
        errCode === 'UND_ERR_CONNECT_TIMEOUT' ||
        errObj.message.includes('fetch failed') ||
        errObj.message.includes('ECONNRESET');

      if (isTransientNetworkOrTimeout && attempt < 2) {
        networkRetryCount++;
        console.warn(
          `[Nemotron VL] Transient OpenRouter timeout/network error on attempt ${attempt}/2 after ${Date.now() - attemptStartMs}ms: ${errObj.message} (${errCode || errObj.name}). Retrying once...`
        );
        lastTransientError = errObj;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw errObj;
    }

    response = fetchedResponse;

    if (!response.ok) {
      const errorBody = await response.text();

      if (response.status >= 502 && response.status <= 504 && attempt < 2) {
        console.warn(`[Nemotron VL] Transient OpenRouter HTTP ${response.status} on attempt ${attempt}/2. Retrying once...`);
        networkRetryCount++;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      throw buildOpenRouterHttpError(response.status, errorBody, 'primary');
    }

    try {
      responseData = await response.json();
      lastTransientError = null;
      console.log(
        `[Nemotron VL] OpenRouter attempt ${attempt}/2 succeeded HTTP ${response.status} in ${Date.now() - attemptStartMs}ms (reqId=${responseData?.id || 'n/a'}).`
      );
      break;
    } catch (bodyErr) {
      const errObj = bodyErr as Error;
      const isTransientRead =
        errObj.name === 'TimeoutError' ||
        errObj.name === 'AbortError' ||
        errObj.message.includes('aborted') ||
        errObj.message.includes('ECONNRESET');
      if (isTransientRead && attempt < 2) {
        networkRetryCount++;
        console.warn(
          `[Nemotron VL] Transient OpenRouter body read error on attempt ${attempt}/2 after ${Date.now() - attemptStartMs}ms: ${errObj.message}. Retrying once...`
        );
        lastTransientError = errObj;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw errObj;
    }
  }

  if (lastTransientError && !responseData) {
    throw lastTransientError;
  }

  const latencyMs = Date.now() - startTimeMs;
  const rawContent = responseData.choices?.[0]?.message?.content?.trim() || '';
  const finishReason = responseData.choices?.[0]?.finish_reason || 'stop';

  const openRouterDetails: OpenRouterDetails = {
    requestId: responseData.id,
    model: responseData.model || NEMOTRON_MODEL,
    promptTokens: responseData.usage?.prompt_tokens,
    completionTokens: responseData.usage?.completion_tokens,
    reasoningTokens: responseData.usage?.completion_tokens_details?.reasoning_tokens,
    totalTokens: responseData.usage?.total_tokens,
    cost: responseData.usage?.cost ?? 0,
    isFreeModel: true,
    latencyMs,
    httpStatus: response.status,
    finishReason,
    rawResponse: rawContent,
    repairAttempted: false,
    repairSuccessful: false,
    repairRetryCount: 0,
    networkRetryCount,
  };

  if (finishReason === 'length') {
    console.warn('[Nemotron VL] Warning: OpenRouter response finish_reason is "length" (truncated output).');
  }

  if (!rawContent) {
    openRouterDetails.jsonParsingStatus = 'model_invalid_json';
    openRouterDetails.errorMessage = `Nemotron returned empty message content (finish_reason=${finishReason}, reasoningTokens=${openRouterDetails.reasoningTokens ?? 0}, completionTokens=${openRouterDetails.completionTokens ?? 0}).`;
    throw new Error(openRouterDetails.errorMessage);
  }

  // 7. Parse and Validate JSON with Controlled 1-Shot Repair
  let parsedObject: any = null;
  let initialParseError: Error | null = null;

  try {
    const sanitized = extractAndSanitizeJson(rawContent);
    parsedObject = JSON.parse(sanitized);
    openRouterDetails.jsonParsingStatus = 'json_parsed_successfully';
    openRouterDetails.schemaValidationStatus = 'passed';
  } catch (parseErr) {
    initialParseError = parseErr as Error;
    console.warn(`[Nemotron VL] Initial JSON parse failed: ${initialParseError.message}. Initiating 1-shot repair retry...`);
    openRouterDetails.repairAttempted = true;
    openRouterDetails.repairRetryCount = 1;

    try {
      const repairResult = await repairNemotronJsonWithOpenRouter(
        rawContent,
        initialParseError.message,
        apiKey
      );
      parsedObject = repairResult.repairedJson;
      openRouterDetails.repairSuccessful = true;
      openRouterDetails.jsonParsingStatus = 'repaired_successfully';
      openRouterDetails.schemaValidationStatus = 'repaired';
      console.log(`[Nemotron VL] JSON repair succeeded in ${repairResult.latencyMs}ms!`);
    } catch (repairErr) {
      openRouterDetails.repairSuccessful = false;
      openRouterDetails.jsonParsingStatus = 'repair_failed';
      openRouterDetails.schemaValidationStatus = 'failed';
      openRouterDetails.errorMessage = `Initial parse error: ${initialParseError.message}. Repair error: ${(repairErr as Error).message}`;
      console.error('[Nemotron VL] JSON repair attempt failed:', (repairErr as Error).message);
      throw new Error(`Nemotron response could not be parsed or repaired as valid JSON: ${(repairErr as Error).message}`);
    }
  }

  // 8. Schema Extraction
  const modelReportedInsufficient = Boolean(parsedObject?.hasInsufficientContent);
  const analysisSummary = String(
    parsedObject?.analysisSummary ||
      (modelReportedInsufficient
        ? `Insufficient coherent footage for ${policy.label} (${policy.idealRange}).`
        : `Completed ${policy.label} analysis.`)
  );

  let rawCandidates: any[] = [];
  if (parsedObject && typeof parsedObject === 'object') {
    if (Array.isArray(parsedObject.clips)) {
      rawCandidates = parsedObject.clips;
    } else if (Array.isArray(parsedObject)) {
      rawCandidates = parsedObject;
    } else if (Array.isArray(parsedObject.moments)) {
      rawCandidates = parsedObject.moments;
    }
  }

  const rejectedMoments: Array<{ title?: string; start: number; end: number; reason: string }> = [];
  const normalizedClips: NemotronParsedClip[] = [];

  for (const cand of rawCandidates) {
    const normalized = validateAndNormalizeCandidate(cand, duration, segmentStart, segmentEnd);
    if (normalized) {
      normalizedClips.push(normalized);
    } else if (cand && typeof cand === 'object') {
      rejectedMoments.push({
        title: String(cand.title || 'Invalid Candidate'),
        start: Number(cand.startTime ?? cand.start ?? 0) || 0,
        end: Number(cand.endTime ?? cand.end ?? 0) || 0,
        reason: 'Candidate timestamps invalid or out of source video bounds.',
      });
    }
  }

  // IMPORTANT: NEVER fabricate synthetic clips when Nemotron returns 0 valid candidates!
  if (normalizedClips.length === 0) {
    if (parsedObject?.hasInsufficientContent !== undefined || Array.isArray(parsedObject?.clips)) {
      openRouterDetails.jsonParsingStatus = openRouterDetails.repairAttempted
        ? 'repaired_successfully'
        : 'json_parsed_successfully';
    } else {
      openRouterDetails.jsonParsingStatus = 'schema_validation_failed';
    }

    const sourceMetaPayload = {
      width: sourceProbe.width,
      height: sourceProbe.height,
      fps: sourceProbe.fps,
      format: sourceProbe.format,
      hasAudio: sourceProbe.hasAudio,
      bitrate: sourceProbe.bitrate,
    };

    return {
      clips: [],
      rejectedMoments,
      openRouterDetails,
      hasInsufficientContent: true,
      analysisSummary,
      transcriptVerification: transcriptCtx.verification,
      sourceMetadata: sourceMetaPayload,
    };
  }

  // 9. Validate every candidate against Editorial Duration, Transcript Alignment, Interval Audio, Decodability, and Visual Progression
  const validatedClips: ClipSuggestion[] = [];
  let alignedTranscriptCount = 0;

  for (let i = 0; i < normalizedClips.length; i++) {
    const m = normalizedClips[i];
    const origStart = m.startTime;
    const origEnd = m.endTime;

    // Step 9A: Enforce Editorial Duration BEFORE or AFTER transcript/transition alignment
    const rawDuration = Math.round((origEnd - origStart) * 10) / 10;
    const initialDurationCheck = validateEditorialDuration(rawDuration, policy.style);
    if (!initialDurationCheck.valid) {
      rejectedMoments.push({
        title: m.title,
        start: origStart,
        end: origEnd,
        reason: initialDurationCheck.reason!,
      });
      console.warn(`[Nemotron VL] Rejected candidate "${m.title}" [${origStart}s-${origEnd}s]: ${initialDurationCheck.reason}`);
      continue;
    }

    // Step 9B: Align with timestamped transcript sentences (if real transcript exists)
    let workStart = origStart;
    let workEnd = origEnd;
    let transcriptSegmentText: string | undefined;
    const transitionNotes: string[] = [];
    let boundaryAdjusted = false;

    if (transcriptCtx.segments.length > 0) {
      const tAlign = alignClipWithTranscriptSegments({
        startTime: workStart,
        endTime: workEnd,
        videoDuration: duration,
        segments: transcriptCtx.segments,
        editorialStyle: policy.style,
      });
      if (tAlign.aligned) {
        workStart = tAlign.startTime;
        workEnd = tAlign.endTime;
        boundaryAdjusted = true;
        if (tAlign.notes) transitionNotes.push(tAlign.notes);
      }
      if (tAlign.transcriptText) {
        transcriptSegmentText = tAlign.transcriptText;
        alignedTranscriptCount++;
      }
    }

    // Step 9C: Transition-aware Quality Inspection + Visual Progression check
    const qualityCheck = await validateSegmentQuality(
      sourcePath,
      workStart,
      workEnd,
      duration,
      policy.minDuration,
      policy.maxDuration,
      precomputedQuality
    );

    if (!qualityCheck.isValid) {
      rejectedMoments.push({
        title: m.title,
        start: workStart,
        end: workEnd,
        reason: qualityCheck.rejectionReason || 'Failed content quality & transition continuity inspection.',
      });
      console.warn(`[Nemotron VL] Rejected candidate "${m.title}": ${qualityCheck.rejectionReason}`);
      continue;
    }

    const finalStart = qualityCheck.adjustedStartTime;
    const finalEnd = qualityCheck.adjustedEndTime;
    const finalDuration = Math.round((finalEnd - finalStart) * 10) / 10;

    if (qualityCheck.boundaryAdjusted) {
      boundaryAdjusted = true;
    }
    if (qualityCheck.transitionNotes.length > 0) {
      transitionNotes.push(...qualityCheck.transitionNotes);
    }

    // Step 9D: Re-verify Editorial Duration, Decodability, and Interval Audio on final timestamps
    const finalDurCheck = validateEditorialDuration(finalDuration, policy.style);
    const [isDecodable, intervalAudio] = await Promise.all([
      verifyDecodableRange(sourcePath, finalStart, finalEnd),
      probeIntervalAudioActivity(sourcePath, finalStart, finalEnd, hasAudio),
    ]);

    const verification = evaluateCandidateVerification({
      candidate: m,
      qualityCheck,
      isDecodable,
      editorialDurationValid: finalDurCheck.valid,
      hasAudio,
      intervalAudio,
      transcriptAvailable: transcriptCtx.verification.transcriptAvailable,
      transcriptSegmentText,
      boundaryAdjusted,
    });

    if (!verification.accepted) {
      rejectedMoments.push({
        title: m.title,
        start: finalStart,
        end: finalEnd,
        reason: verification.rejectionReason || finalDurCheck.reason || 'Candidate failed source verification checks.',
      });
      console.warn(`[Nemotron VL] Rejected candidate "${m.title}" [${finalStart}s-${finalEnd}s]: ${verification.rejectionReason}`);
      continue;
    }

    const avgScore =
      (m.scores.hookStrength +
        m.scores.audienceCuriosity +
        m.scores.informationalValue +
        m.scores.storyFlow +
        m.scores.standaloneContext +
        m.scores.payoff +
        m.scores.shareability) /
      7;

    const overallViralityScore = Math.min(99, Math.max(60, Math.round(avgScore * 10)));

    const scores: ViralScores = {
      hook: m.scores.hookStrength,
      standalone: m.scores.standaloneContext,
      emotion: m.scores.informationalValue,
      payoff: m.scores.payoff,
      share_worthy: m.scores.shareability,
      pacing: m.scores.storyFlow,
      visual_potential: m.scores.audienceCuriosity,
      overall_average: Math.round(avgScore * 10) / 10,
    };

    const altHooks: string[] =
      Array.isArray(m.alternate_hooks) && m.alternate_hooks.length >= 2
        ? [m.alternate_hooks[0], m.alternate_hooks[1]]
        : ['Did you notice this key turning point?', 'Watch how this resolves.'];

    const quote = transcriptSegmentText || (transcriptCtx.verification.transcriptAvailable ? m.exact_quote : undefined);
    const factualDesc = m.factualDescription || m.reason;
    const resolvedAudioEvidence =
      m.audioEvidence ||
      (transcriptSegmentText
        ? `Transcript [${finalStart.toFixed(1)}s-${finalEnd.toFixed(1)}s]: "${transcriptSegmentText.slice(0, 220)}"`
        : hasAudio
        ? `Audio stream ${intervalAudio.audioActive ? 'active' : 'near-silent'} (${intervalAudio.meanVolumeDb !== undefined ? `${intervalAudio.meanVolumeDb.toFixed(1)} dB mean` : 'probed'}); no verified transcript.`
        : 'No audio track in source video.');

    validatedClips.push({
      id: `clip-nemotron-${Date.now()}-${i + 1}`,
      clipId: `nemotron_${chunkName}_${i + 1}`,
      clip_id: `nemotron_${chunkName}_${i + 1}`,
      sourceVideoId,
      title: m.title,
      hook: m.hook,
      description: factualDesc,
      factualDescription: factualDesc,
      visualEvidence: m.visualEvidence,
      audioEvidence: resolvedAudioEvidence,
      uncertaintyNote: verification.uncertaintyNote,
      verificationStatus: verification.verificationStatus,
      verificationChecks: verification.checks,
      startTime: finalStart,
      endTime: finalEnd,
      start: finalStart,
      end: finalEnd,
      originalStartTime: origStart,
      originalEndTime: origEnd,
      boundaryAdjusted,
      transitionNotes: transitionNotes.length > 0 ? transitionNotes : undefined,
      evidenceMode: transcriptCtx.verification.evidenceMode,
      transcriptSegment: transcriptSegmentText,
      editorialStyle: policy.style,
      duration: finalDuration,
      duration_seconds: finalDuration,
      viralityScore: overallViralityScore,
      score: overallViralityScore,
      confidence: m.confidence,
      category: m.category,
      viralityReason: m.reason,
      reason: m.reason,
      targetPlatform: 'all',
      suggestedAspectRatio: '9:16',
      captions: m.hook,
      hashtags: ['#viral', '#shorts', '#trending', '#reels'],
      keyQuotes: quote ? [quote] : [m.hook],
      exact_quote: quote,
      weakness: m.weakness,
      alternate_hooks: altHooks,
      scores,
      analysisStatus: 'completed',
      reviewStatus: 'needs_review',
      publishStatus: 'draft',
      thumbnailUrl: `/api/thumbnails/clip/${sourceVideoId}?t=${Math.round(finalStart)}`,
      selected: true,
      qualityCheckPassed: true,
    });
  }

  // 10. Multi-Candidate Deduplication (Overlap > 45% OR Repeated Idea Similarity > 0.60)
  // Rank higher-scoring candidates first so weaker duplicates are rejected cleanly
  validatedClips.sort((a, b) => (b.viralityScore || 0) - (a.viralityScore || 0));

  const nonOverlapping: ClipSuggestion[] = [];
  for (const candidate of validatedClips) {
    const overlappingExisting = nonOverlapping.find((existing) => {
      const overlapStart = Math.max(candidate.startTime, existing.startTime);
      const overlapEnd = Math.min(candidate.endTime, existing.endTime);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const minDuration = Math.min(candidate.duration, existing.duration);
      return overlap / minDuration > 0.45;
    });

    if (overlappingExisting) {
      rejectedMoments.push({
        title: candidate.title,
        start: candidate.startTime,
        end: candidate.endTime,
        reason: `Overlaps (>45%) with higher-scoring candidate "${overlappingExisting.title}" [${overlappingExisting.startTime}s-${overlappingExisting.endTime}s].`,
      });
      continue;
    }

    const topicDuplicate = nonOverlapping.find((existing) => {
      const sim = computeTopicSimilarity(
        `${candidate.title} ${candidate.hook} ${candidate.description}`,
        `${existing.title} ${existing.hook} ${existing.description}`
      );
      return sim > 0.6;
    });

    if (topicDuplicate) {
      rejectedMoments.push({
        title: candidate.title,
        start: candidate.startTime,
        end: candidate.endTime,
        reason: `Repeated variation of the same idea already covered by "${topicDuplicate.title}".`,
      });
      continue;
    }

    nonOverlapping.push(candidate);
  }

  // Also reject any lower-ranked excess clips beyond requested clipCount transparently
  const finalClips = nonOverlapping.slice(0, Math.max(1, clipCount));
  for (let i = Math.max(1, clipCount); i < nonOverlapping.length; i++) {
    const extra = nonOverlapping[i];
    rejectedMoments.push({
      title: extra.title,
      start: extra.startTime,
      end: extra.endTime,
      reason: `Lower rank than top ${clipCount} selected moments (score ${extra.viralityScore}/100).`,
    });
  }

  // Sort final accepted clips chronologically for clean studio workflow
  finalClips.sort((a, b) => a.startTime - b.startTime);

  transcriptCtx.verification.alignedSegmentsCount = alignedTranscriptCount;

  const sourceMetaPayload = {
    width: sourceProbe.width,
    height: sourceProbe.height,
    fps: sourceProbe.fps,
    format: sourceProbe.format,
    hasAudio: sourceProbe.hasAudio,
    bitrate: sourceProbe.bitrate,
  };

  return {
    clips: finalClips,
    rejectedMoments,
    openRouterDetails,
    hasInsufficientContent: finalClips.length === 0 ? true : modelReportedInsufficient && finalClips.length === 0,
    analysisSummary:
      finalClips.length === 0
        ? `${analysisSummary} (${rejectedMoments.length} candidate(s) rejected for editorial duration or source verification compliance.)`
        : analysisSummary,
    transcriptVerification: transcriptCtx.verification,
    sourceMetadata: sourceMetaPayload,
  };
}
