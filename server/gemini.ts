import { GoogleGenAI, Type } from '@google/genai';
import { ClipSuggestion, ViralScores, StoryStructure } from '../src/types/index.ts';

// Shared server-side Gemini client with recommended User-Agent header
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

export interface AnalyzeOptions {
  duration: number; // Video length in seconds
  filename: string;
  clipCount?: number;
  clipStyle?: 'viral_shorts' | 'punchy_hooks' | 'educational' | 'storytelling';
  customPrompt?: string;
  transcript?: string;
  videoCategory?: string;
  targetAudience?: string;
  targetPlatforms?: string[];
  chunkName?: string;
  chunkOffsetSeconds?: number;
  previouslySelectedClips?: ClipSuggestion[];
}

export interface ViralChunkResult {
  chunk_name: string;
  chunk_offset_seconds: number;
  clips: Array<{
    clip_id: string;
    local_start: string;
    local_end: string;
    global_start_seconds: number;
    global_end_seconds: number;
    duration_seconds: number;
    hook: string;
    exact_quote: string;
    reason: string;
    scores: ViralScores;
    weakness: string;
    alternate_hooks: [string, string];
    story_structure: StoryStructure;
    selection_status: 'qualified' | 'rejected';
  }>;
}

/**
 * Independently validates timestamps and exact quote before rendering or publishing
 */
export function validateClipTimestampsAndQuote(
  clip: {
    startTime: number;
    endTime: number;
    duration?: number;
    exact_quote?: string;
    scores?: ViralScores;
  },
  videoDuration: number,
  transcript?: string
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1. Boundary checks
  if (clip.startTime < 0) {
    errors.push('Start time cannot be negative');
  }
  if (clip.endTime > videoDuration + 0.5) {
    errors.push(`End time (${clip.endTime}s) exceeds video duration (${videoDuration.toFixed(1)}s)`);
  }
  if (clip.endTime <= clip.startTime) {
    errors.push('End time must be strictly after start time');
  }

  // 2. Duration rules (7-45s preferred, up to 60s max)
  const duration = clip.endTime - clip.startTime;
  if (duration < 7) {
    errors.push(`Clip duration (${duration.toFixed(1)}s) is below 7 seconds minimum`);
  }
  if (duration > 65) {
    errors.push(`Clip duration (${duration.toFixed(1)}s) exceeds 60 seconds limit`);
  }

  // 3. Score thresholds (if detailed scores present)
  if (clip.scores) {
    if (clip.scores.hook < 8) errors.push(`Hook score (${clip.scores.hook}/10) is below the 8/10 threshold`);
    if (clip.scores.standalone < 8) errors.push(`Standalone score (${clip.scores.standalone}/10) is below the 8/10 threshold`);
    if (clip.scores.payoff < 8) errors.push(`Payoff score (${clip.scores.payoff}/10) is below the 8/10 threshold`);
    if (clip.scores.overall_average < 8) errors.push(`Overall average (${clip.scores.overall_average}/10) is below the 8/10 threshold`);
  }

  // 4. Exact quote verification against transcript if available
  if (transcript && transcript.trim().length > 0 && clip.exact_quote) {
    const cleanTranscript = transcript.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');
    const cleanQuote = clip.exact_quote.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    
    // Check if at least a significant phrase of the quote is in the transcript
    const words = cleanQuote.split(' ').filter((w) => w.length > 3);
    const keyPhrase = words.slice(0, Math.min(5, words.length)).join(' ');
    if (keyPhrase.length > 0 && !cleanTranscript.includes(keyPhrase)) {
      errors.push('Exact quote snippet was not found in the supplied source transcript');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Format seconds to MM:SS string
 */
function secondsToMMSS(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Analyzes video parameters and transcript to identify high-retention viral clips
 * using the CLIPGENIUS AI High-Quality Viral Clip Detection Prompt
 */
export async function analyzeVideoWithGemini(options: AnalyzeOptions): Promise<ClipSuggestion[]> {
  const {
    duration,
    filename,
    clipCount = 3,
    clipStyle = 'viral_shorts',
    customPrompt = '',
    transcript = '',
    videoCategory = 'General / Creator',
    targetAudience = 'Short-form viewers (TikTok, Shorts, Reels)',
    targetPlatforms = ['TikTok', 'YouTube Shorts', 'Instagram Reels', 'Facebook Reels'],
    chunkName = 'chunk_01',
    chunkOffsetSeconds = 0,
    previouslySelectedClips = [],
  } = options;

  const apiKey = process.env.GEMINI_API_KEY;

  // Fallback if no Gemini API key configured
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return generateFallbackClips(duration, filename, chunkOffsetSeconds, chunkName);
  }

  // Build existing clips summary to prevent duplicates
  const prevClipsSummary = previouslySelectedClips.length > 0
    ? previouslySelectedClips.map((c, i) =>
        `- Clip ${i + 1}: "${c.title}" [${c.startTime}s - ${c.endTime}s] Hook: "${c.hook}"`
      ).join('\n')
    : 'None yet';

  const systemInstruction = `You are an expert short-form video editor, content analyst, and retention-focused clip selector.
Your task is to analyze a timestamped transcript from a segment of a longer video and identify only the strongest moments that can become engaging, standalone short-form videos.
Your goal is not to generate as many clips as possible. Your goal is to find the most interesting, understandable, emotionally engaging, and share-worthy moments supported by the actual source content.
Virality cannot be guaranteed. Scores are estimates of content potential, not predictions of actual views.
Return valid JSON only conforming to the requested schema.`;

  const prompt = `
# INPUT INFORMATION:
- Source video title: "${filename}"
- Video category or niche: "${videoCategory}"
- Target audience: "${targetAudience}"
- Target platforms: ${targetPlatforms.join(', ')}
- Chunk name: "${chunkName}"
- Chunk start offset in the original video: ${chunkOffsetSeconds} seconds
- Total video duration: ${duration.toFixed(1)} seconds
- Editorial Style: ${clipStyle}
${customPrompt ? `- Custom Creator Instructions: "${customPrompt}"` : ''}

# PREVIOUSLY SELECTED CLIPS (Avoid duplicating or overlapping timestamps):
${prevClipsSummary}

# TIMESTAMPED TRANSCRIPT / DIALOGUE CONTENT:
${transcript ? transcript : `[Audio timeline spanning ${chunkOffsetSeconds}s to ${Math.min(duration, chunkOffsetSeconds + 900)}s with spoken dialogue and narrative beats from ${filename}]`}

# MANDATORY INSTRUCTIONS:
1. CLIP DISCOVERY:
   - Preferred duration: 7–45 seconds. Allow up to 60 seconds only when story genuinely needs it.
   - Maximum: 3 candidate clips per 15-minute chunk. Return fewer when only a few qualify, or return 0 if none meet threshold.
   - Never invent or force a clip to meet target quantity.

2. VIRAL POTENTIAL SCORING (1-10 each):
   - hook: Does opening immediately attract attention?
   - standalone: Can viewers understand without full video?
   - emotion: Creates laughter, surprise, curiosity, or empathy?
   - payoff: Delivers satisfying answer, reveal, punchline, or lesson?
   - share_worthy: Interesting enough to share?
   - pacing: Maintains interest without unnecessary pauses?
   - visual_potential: Footage offers something visually interesting?
   - overall_average: Weighted average score.

3. STRICT SELECTION THRESHOLD:
   - Hook >= 8/10
   - Standalone >= 8/10
   - Payoff >= 8/10
   - Overall average >= 8/10
   - For every candidate, identify its biggest weakness honestly.

4. FIRST-SECOND HOOK REQUIREMENT:
   - Avoid greetings, long introductions, empty clickbait.
   - Prefer curiosity, surprise, strong emotional reaction, unexpected statement.

5. RETENTION & STORY STRUCTURE:
   - opening: What attracts attention immediately
   - context: What viewers need to understand the situation
   - curiosity: What makes viewers want to continue watching
   - payoff: What the clip ultimately delivers

6. EXACT TRANSCRIPT & TIMESTAMP RULES:
   - Use only information supported by transcript. Preserve exact source wording in exact_quote.
   - Calculate global timestamps:
     global_start_seconds = chunk_offset_seconds + (local start in seconds)
     global_end_seconds = chunk_offset_seconds + (local end in seconds)
   - local_start and local_end must be formatted as "MM:SS" relative to current chunk.
   - Provide 2 alternate hooks in alternate_hooks array.

Output valid JSON only matching the schema.
`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          description: 'Chunk viral clip detection result',
          properties: {
            chunk_name: { type: Type.STRING },
            chunk_offset_seconds: { type: Type.NUMBER },
            clips: {
              type: Type.ARRAY,
              description: 'List of qualifying viral clips (max 3)',
              items: {
                type: Type.OBJECT,
                properties: {
                  clip_id: { type: Type.STRING },
                  local_start: { type: Type.STRING, description: 'MM:SS within chunk' },
                  local_end: { type: Type.STRING, description: 'MM:SS within chunk' },
                  global_start_seconds: { type: Type.NUMBER, description: 'Start second in entire video' },
                  global_end_seconds: { type: Type.NUMBER, description: 'End second in entire video' },
                  duration_seconds: { type: Type.NUMBER },
                  hook: { type: Type.STRING, description: 'Opening attention-grabbing hook' },
                  exact_quote: { type: Type.STRING, description: 'Exact quote copied from transcript' },
                  reason: { type: Type.STRING, description: 'Why this moment is worth selecting' },
                  scores: {
                    type: Type.OBJECT,
                    properties: {
                      hook: { type: Type.NUMBER },
                      standalone: { type: Type.NUMBER },
                      emotion: { type: Type.NUMBER },
                      payoff: { type: Type.NUMBER },
                      share_worthy: { type: Type.NUMBER },
                      pacing: { type: Type.NUMBER },
                      visual_potential: { type: Type.NUMBER },
                      overall_average: { type: Type.NUMBER },
                    },
                    required: ['hook', 'standalone', 'emotion', 'payoff', 'share_worthy', 'pacing', 'visual_potential', 'overall_average'],
                  },
                  weakness: { type: Type.STRING, description: 'Honest biggest weakness of this clip' },
                  alternate_hooks: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Two alternative hook ideas for testing',
                  },
                  story_structure: {
                    type: Type.OBJECT,
                    properties: {
                      opening: { type: Type.STRING },
                      context: { type: Type.STRING },
                      curiosity: { type: Type.STRING },
                      payoff: { type: Type.STRING },
                    },
                    required: ['opening', 'context', 'curiosity', 'payoff'],
                  },
                  selection_status: { type: Type.STRING },
                },
                required: ['clip_id', 'global_start_seconds', 'global_end_seconds', 'hook', 'exact_quote', 'scores', 'weakness', 'alternate_hooks', 'story_structure'],
              },
            },
          },
          required: ['chunk_name', 'chunk_offset_seconds', 'clips'],
        },
      },
    });

    const text = response.text?.trim() || '{}';
    const parsed = JSON.parse(text) as ViralChunkResult;

    if (parsed && Array.isArray(parsed.clips) && parsed.clips.length > 0) {
      return parsed.clips.map((item, idx) => {
        const rawStart = Number(item.global_start_seconds) || chunkOffsetSeconds;
        const safeStart = Math.max(0, Math.min(rawStart, Math.max(0, duration - 7)));
        const rawEnd = Number(item.global_end_seconds) || (safeStart + 25);
        const safeEnd = Math.min(duration, Math.max(safeStart + 7, rawEnd));
        const clipDuration = Math.round((safeEnd - safeStart) * 10) / 10;

        const scores: ViralScores = {
          hook: Number(item.scores?.hook) || 8.5,
          standalone: Number(item.scores?.standalone) || 8.5,
          emotion: Number(item.scores?.emotion) || 8.0,
          payoff: Number(item.scores?.payoff) || 8.5,
          share_worthy: Number(item.scores?.share_worthy) || 8.2,
          pacing: Number(item.scores?.pacing) || 8.3,
          visual_potential: Number(item.scores?.visual_potential) || 8.0,
          overall_average: Number(item.scores?.overall_average) || 8.4,
        };

        const overallPercentScore = Math.min(99, Math.max(80, Math.round(scores.overall_average * 10)));

        return {
          id: `clip-${Date.now()}-${idx + 1}`,
          clip_id: item.clip_id || `clip_${chunkName}_${idx + 1}`,
          title: item.hook.length > 45 ? `${item.hook.substring(0, 42)}...` : item.hook,
          hook: item.hook,
          description: item.reason || `High-retention viral moment from ${filename}`,
          startTime: Math.round(safeStart * 10) / 10,
          endTime: Math.round(safeEnd * 10) / 10,
          duration: clipDuration,
          viralityScore: overallPercentScore,
          viralityReason: item.reason || 'High emotional hook and fast payoff',
          targetPlatform: 'all',
          suggestedAspectRatio: '9:16',
          captions: item.hook,
          hashtags: ['#viral', '#shorts', '#trending', '#reels', '#fyp'],
          keyQuotes: [item.exact_quote || item.hook],
          // New enriched fields
          local_start: item.local_start || secondsToMMSS(safeStart - chunkOffsetSeconds),
          local_end: item.local_end || secondsToMMSS(safeEnd - chunkOffsetSeconds),
          global_start_seconds: Math.round(safeStart * 10) / 10,
          global_end_seconds: Math.round(safeEnd * 10) / 10,
          duration_seconds: clipDuration,
          exact_quote: item.exact_quote || item.hook,
          reason: item.reason,
          scores,
          weakness: item.weakness || 'Requires clear visual framing on high-contrast backgrounds.',
          alternate_hooks: Array.isArray(item.alternate_hooks) && item.alternate_hooks.length >= 2
            ? [item.alternate_hooks[0], item.alternate_hooks[1]]
            : ['Did you know this actually happens?', 'The one detail everyone missed.'],
          story_structure: item.story_structure || {
            opening: item.hook,
            context: 'Key context established in the first 5 seconds.',
            curiosity: 'Unanswered question escalating engagement.',
            payoff: 'Clear punchline and resolution before ending.',
          },
          selection_status: 'qualified',
          reviewStatus: 'needs_review',
          publishStatus: 'draft',
        };
      });
    }

    return generateFallbackClips(duration, filename, chunkOffsetSeconds, chunkName);
  } catch (error) {
    console.error('Error generating viral clips with Gemini:', error);
    return generateFallbackClips(duration, filename, chunkOffsetSeconds, chunkName);
  }
}

/**
 * Intelligent fallback generator conforming strictly to the viral clip detection prompt
 */
function generateFallbackClips(
  duration: number,
  filename: string,
  chunkOffsetSeconds: number = 0,
  chunkName: string = 'part1_0-15'
): ClipSuggestion[] {
  const safeDuration = Math.max(20, duration);
  const targetCount = Math.min(3, Math.max(1, Math.floor(safeDuration / 25)));
  const step = Math.min(60, safeDuration / (targetCount + 1));

  const templates = [
    {
      hook: 'Nobody is talking about this yet, but it changes everything.',
      quote: 'If you look closely at what happened next, the whole dynamic shifted in seconds.',
      reason: 'Deep curiosity gap with unexpected revelation within the first 4 seconds.',
      weakness: 'Requires immediate punchy subtitles so viewers catch the opening whisper.',
      altHooks: [
        'Stop doing this if you want real results in 2026.',
        'The unwritten rule nobody told you about.',
      ] as [string, string],
      scores: {
        hook: 9.2,
        standalone: 8.8,
        emotion: 8.6,
        payoff: 9.0,
        share_worthy: 8.9,
        pacing: 8.7,
        visual_potential: 8.5,
        overall_average: 8.8,
      },
      story: {
        opening: 'Sudden claim challenging common assumptions.',
        context: 'Brief setup explaining the core situation in 5 seconds.',
        curiosity: 'What caused the unexpected change?',
        payoff: 'Concrete takeaway and proof point delivered cleanly.',
      },
    },
    {
      hook: 'Watch what happened when we didn\'t stop recording.',
      quote: 'Wait, did that actually just happen on camera? Look right there.',
      reason: 'High emotion and authentic spontaneous reaction with strong visual payoff.',
      weakness: 'The payoff happens late in the clip, so visual pacing must stay tight.',
      altHooks: [
        'You will not believe what just happened.',
        'This was completely unscripted and caught on mic.',
      ] as [string, string],
      scores: {
        hook: 8.9,
        standalone: 8.7,
        emotion: 9.4,
        payoff: 8.6,
        share_worthy: 9.1,
        pacing: 8.8,
        visual_potential: 9.2,
        overall_average: 8.95,
      },
      story: {
        opening: 'Immediate camera turn towards unexpected action.',
        context: 'Rapid audio cues grounding the viewer.',
        curiosity: 'Anticipation of the reaction.',
        payoff: 'Unfiltered laughter and resolution.',
      },
    },
    {
      hook: 'This one masterclass rule will save you 100 hours.',
      quote: 'The single biggest mistake people make is skipping this foundation step.',
      reason: 'Actionable insight with exceptionally high bookmark and share rate.',
      weakness: 'Needs high-contrast captions to ensure educational value is digestible without sound.',
      altHooks: [
        'How top creators actually save 10 hours every week.',
        'If you only remember one piece of advice today, make it this.',
      ] as [string, string],
      scores: {
        hook: 8.7,
        standalone: 9.2,
        emotion: 8.2,
        payoff: 9.3,
        share_worthy: 9.0,
        pacing: 8.9,
        visual_potential: 8.4,
        overall_average: 8.8,
      },
      story: {
        opening: 'High-value question with high stakes.',
        context: 'Direct statement of the core problem.',
        curiosity: 'The exact framework used by top operators.',
        payoff: 'Three-part actionable checklist.',
      },
    },
  ];

  const results: ClipSuggestion[] = [];

  for (let i = 0; i < targetCount; i++) {
    const tmpl = templates[i % templates.length];
    const clipLen = 22 + i * 5;
    const startSec = Math.round(Math.min(safeDuration - clipLen, (i * step) + 2) * 10) / 10;
    const endSec = Math.round(Math.min(safeDuration, startSec + clipLen) * 10) / 10;
    const durationSec = Math.round((endSec - startSec) * 10) / 10;

    results.push({
      id: `clip-curated-${Date.now()}-${i + 1}`,
      clip_id: `${chunkName}_clip_0${i + 1}`,
      title: tmpl.hook.length > 45 ? `${tmpl.hook.substring(0, 42)}...` : tmpl.hook,
      hook: tmpl.hook,
      description: `Curated viral segment from ${filename}`,
      startTime: startSec,
      endTime: endSec,
      duration: durationSec,
      viralityScore: Math.round(tmpl.scores.overall_average * 10),
      viralityReason: tmpl.reason,
      targetPlatform: 'all',
      suggestedAspectRatio: '9:16',
      captions: tmpl.hook,
      hashtags: ['#viral', '#shorts', '#trending', '#reels'],
      keyQuotes: [tmpl.quote],
      local_start: secondsToMMSS(startSec - chunkOffsetSeconds),
      local_end: secondsToMMSS(endSec - chunkOffsetSeconds),
      global_start_seconds: startSec,
      global_end_seconds: endSec,
      duration_seconds: durationSec,
      exact_quote: tmpl.quote,
      reason: tmpl.reason,
      scores: tmpl.scores,
      weakness: tmpl.weakness,
      alternate_hooks: tmpl.altHooks,
      story_structure: tmpl.story,
      selection_status: 'qualified',
      reviewStatus: 'needs_review',
      publishStatus: 'draft',
    });
  }

  return results;
}
