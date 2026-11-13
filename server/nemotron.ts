import fs from 'fs';
import { extractSampleFrames, probeVideo, verifyDecodableRange } from './ffmpeg.ts';
import {
  precomputeVideoQualityContext,
  validateSegmentQuality,
} from './contentQualityInspector.ts';
import { getEditorialPolicy, validateEditorialDuration } from './editorialPolicy.ts';
import {
  alignClipWithTranscriptSegments,
  verifyAndPrepareTranscript,
} from './transcriptVerifier.ts';
import {
  ClipSuggestion,
  ViralScores,
  OpenRouterDetails,
  EditorialCurationStyle,
  JsonParsingStatus,
  TranscriptVerificationInfo,
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
          reason: { type: 'string' },
          confidence: { type: 'number' },
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
          'reason',
          'confidence',
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
  reason: string;
  confidence: number;
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
    throw new Error(`OpenRouter JSON repair HTTP ${response.status}: ${errText.slice(0, 150)}`);
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

  const rawStart = Number(cand.startTime ?? cand.start);
  const rawEnd = Number(cand.endTime ?? cand.end);

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

  const title = String(cand.title || 'Key Video Highlight').trim();
  const hook = String(cand.hook || title).trim();
  const reason = String(cand.reason || 'Meaningful visual/narrative moment').trim();
  const category = String(cand.category || 'General').trim();
  const weakness = String(cand.weakness || 'Requires punchy vertical captions').trim();
  const confidence = Math.min(1.0, Math.max(0.5, Number(cand.confidence) || 0.88));

  // Normalize scores (allow 0-1 scale or 0-10 scale)
  const rawScores = cand.scores || {};
  const normalizeScoreVal = (v: any, fallback: number) => {
    const num = Number(v);
    if (isNaN(num)) return fallback;
    if (num <= 1.0 && num > 0) return Math.round(num * 100) / 10;
    return Math.min(10, Math.max(1, Math.round(num * 10) / 10));
  };

  const scores = {
    hookStrength: normalizeScoreVal(rawScores.hookStrength ?? rawScores.hook, 8.5),
    audienceCuriosity: normalizeScoreVal(rawScores.audienceCuriosity, 8.4),
    informationalValue: normalizeScoreVal(rawScores.informationalValue ?? rawScores.emotion, 8.6),
    storyFlow: normalizeScoreVal(rawScores.storyFlow, 8.3),
    standaloneContext: normalizeScoreVal(rawScores.standaloneContext ?? rawScores.standalone, 8.7),
    payoff: normalizeScoreVal(rawScores.payoff, 8.5),
    shareability: normalizeScoreVal(rawScores.shareability ?? rawScores.share_worthy, 8.6),
  };

  const alternate_hooks = Array.isArray(cand.alternate_hooks)
    ? cand.alternate_hooks.map((h: any) => String(h).trim()).filter(Boolean)
    : undefined;

  const exact_quote = cand.exact_quote ? String(cand.exact_quote).trim() : undefined;

  return {
    title,
    hook,
    startTime,
    endTime,
    reason,
    confidence,
    category,
    weakness,
    alternate_hooks,
    exact_quote,
    scores,
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

  // 2. Probe audio & verify transcript honestly (User-provided or Embedded subtitles, never fabricated)
  let hasAudio = true;
  try {
    const probe = await probeVideo(sourcePath);
    hasAudio = probe.hasAudio;
  } catch {
    hasAudio = true;
  }

  const transcriptCtx = await verifyAndPrepareTranscript({
    videoPath: sourcePath,
    hasAudio,
    userTranscript: transcript,
    usingVisualFrames: true,
  });

  // 3. Precompute video blackouts & scene transitions once
  const precomputedQuality = await precomputeVideoQualityContext(sourcePath);

  // 4. Dense Full-Video Frame Sampling across the entire segment so multiple distinct moments are visible
  const sampleCount =
    effectiveSegmentDuration <= 180
      ? Math.min(14, Math.max(6, Math.ceil(effectiveSegmentDuration / 10)))
      : Math.min(16, Math.max(8, Math.floor(effectiveSegmentDuration / 45)));
  const step = effectiveSegmentDuration / (sampleCount + 1);
  const frameTimestamps: number[] = [];

  for (let i = 1; i <= sampleCount; i++) {
    frameTimestamps.push(Math.round((segmentStart + i * step) * 10) / 10);
  }

  console.log(
    `[Nemotron VL] Extracting ${frameTimestamps.length} frames across [${segmentStart}s - ${segmentEnd}s] for "${filename}" (${policy.label}, target ${policy.idealRange})...`
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
Your mission is to analyze the entire video timeline and identify ONLY genuinely valuable, coherent, distinct short-form clips matching the user's Editorial Curation Style.

MANDATORY EDITORIAL DURATION & QUALITY RULES:
1. SELECTED STYLE: ${policy.label.toUpperCase()}
   - REQUIRED DURATION RANGE: ${policy.minDuration} to ${policy.maxDuration} seconds (endTime - startTime MUST satisfy ${policy.minDuration} <= duration <= ${policy.maxDuration}).
   - ${policy.guidance}
   - NEVER return a 7-second or short fragment when ${policy.minDuration}-${policy.maxDuration}s is required.
   - If the source video does NOT contain a sufficiently long coherent segment (${policy.minDuration}s+), set "hasInsufficientContent": true, return an empty "clips": [] array, and explain why in "analysisSummary" instead of inventing duration or padding unrelated footage.
2. MULTIPLE CANDIDATE DISCOVERY:
   - Search the ENTIRE timeline (${segmentStart.toFixed(1)}s to ${segmentEnd.toFixed(1)}s) to find up to ${clipCount} DISTINCT, non-overlapping moments covering different ideas or chapters.
   - Avoid returning repeated variations of the same topic or overlapping timestamps.
   - Return fewer than ${clipCount} clips (or 0) if fewer genuine moments exist. Never force filler clips.
3. SCENE-TRANSITION & QUALITY FILTERING:
   - Reject SMPTE color bars, EBU color bars, test patterns, pitch-black dead screens, or frozen technical failures.
   - Normal editing transitions or brief chapter cuts between valid topic frames are acceptable if continuity holds, or adjust start/end cleanly to align with complete topic boundaries.
4. HONEST EVIDENCE:
   - Do NOT invent timestamps outside [${segmentStart.toFixed(1)}, ${segmentEnd.toFixed(1)}].
   - If no transcript was supplied, leave exact_quote empty or cite ONLY exact text visible on-screen.
5. Output ONLY valid JSON conforming strictly to the schema.`;

  const userPromptText = `
VIDEO INFORMATION:
- Title: "${filename}"
- Category: "${category}"
- Segment Range: ${segmentStart.toFixed(1)}s to ${segmentEnd.toFixed(1)}s (Total Video Duration: ${duration.toFixed(1)}s)
- Target Platforms: ${targetPlatforms.join(', ')}
- Editorial Curation Style: ${policy.style} (${policy.label}) — STRICT DURATION: ${policy.minDuration}s to ${policy.maxDuration}s
- Detected Scene Cuts: ${sceneMarkerText}
${creatorDirection ? `- Creator Direction: "${creatorDirection}"` : ''}

${transcriptSection}

PREVIOUSLY SELECTED MOMENTS (DO NOT DUPLICATE OR OVERLAP):
${prevClipsText}

VISUAL TIMELINE FRAMES (${extractedFrames.length} frames sampled across entire video):
${frameDescriptions.join('\n')}

INSTRUCTIONS:
Identify up to ${clipCount} distinct, high-retention moments across the full timeline that strictly satisfy ${policy.minDuration}s–${policy.maxDuration}s duration and "${policy.label}" curation.
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
      console.error(`[Nemotron VL] OpenRouter error HTTP ${response.status} (attempt ${attempt}/2):`, errorBody);

      if (response.status >= 502 && response.status <= 504 && attempt < 2) {
        networkRetryCount++;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (response.status === 429) {
        throw new Error('OpenRouter rate limit reached (HTTP 429). Please wait a moment or use Gemini fallback.');
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`OpenRouter authentication failed (HTTP ${response.status}). Check OPENROUTER_API_KEY in environment.`);
      }
      throw new Error(`Nemotron AI analysis failed at OpenRouter (HTTP ${response.status}): ${errorBody.slice(0, 150)}`);
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

    return {
      clips: [],
      rejectedMoments,
      openRouterDetails,
      hasInsufficientContent: true,
      analysisSummary,
      transcriptVerification: transcriptCtx.verification,
    };
  }

  // 9. Validate every candidate against Editorial Duration, Transcript Alignment, Decodability, and Scene-Transition Filtering
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

    // Step 9C: Transition-aware Quality Inspection (inspects actual frames around transitions & blackouts)
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

    // Step 9D: Re-verify Editorial Duration and Decodability on final timestamps
    const finalDurCheck = validateEditorialDuration(finalDuration, policy.style);
    if (!finalDurCheck.valid) {
      rejectedMoments.push({
        title: m.title,
        start: finalStart,
        end: finalEnd,
        reason: `After boundary adjustment: ${finalDurCheck.reason}`,
      });
      continue;
    }

    const isDecodable = await verifyDecodableRange(sourcePath, finalStart, finalEnd);
    if (!isDecodable) {
      rejectedMoments.push({
        title: m.title,
        start: finalStart,
        end: finalEnd,
        reason: 'Video frames could not be decoded by FFmpeg in this range.',
      });
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

    validatedClips.push({
      id: `clip-nemotron-${Date.now()}-${i + 1}`,
      clipId: `nemotron_${chunkName}_${i + 1}`,
      clip_id: `nemotron_${chunkName}_${i + 1}`,
      sourceVideoId,
      title: m.title,
      hook: m.hook,
      description: m.reason,
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

  const hasInsufficientContent = finalClips.length === 0 || modelReportedInsufficient;

  return {
    clips: finalClips,
    rejectedMoments,
    openRouterDetails,
    hasInsufficientContent: finalClips.length === 0 ? true : false,
    analysisSummary:
      finalClips.length === 0
        ? `${analysisSummary} (${rejectedMoments.length} candidate(s) rejected for editorial duration or quality compliance.)`
        : analysisSummary,
    transcriptVerification: transcriptCtx.verification,
  };
}
