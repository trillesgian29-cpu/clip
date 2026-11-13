import { exec } from 'child_process';
import { promisify } from 'util';
import { TranscriptSegment, TranscriptVerificationInfo, EditorialCurationStyle } from '../src/types/index.ts';
import { getEditorialPolicy } from './editorialPolicy.ts';

const execAsync = promisify(exec);

/**
 * Parse timestamp strings like "00:01:23.450", "01:23,450", "01:23" into seconds
 */
export function parseTimecodeToSeconds(tc: string): number {
  const clean = tc.trim().replace(',', '.');
  const parts = clean.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => isNaN(n))) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

/**
 * Parse SRT, WebVTT, or [MM:SS] timestamped transcripts into structured segments
 */
export function parseTimestampedTranscript(rawTranscript: string): TranscriptSegment[] {
  if (!rawTranscript || !rawTranscript.trim()) return [];
  const text = rawTranscript.trim();
  const segments: TranscriptSegment[] = [];

  // 1. Check SRT / VTT cue pattern: 00:00:05,000 --> 00:00:12,500
  const cueRegex = /(?:^|\n)(?:\d+\s*\n)?(\d{1,2}:?\d{2}:\d{2}(?:[.,]\d{1,3})?|\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*(\d{1,2}:?\d{2}:\d{2}(?:[.,]\d{1,3})?|\d{1,2}:\d{2}(?:[.,]\d{1,3})?)[^\n]*\n([\s\S]*?)(?=\n\s*\n|\n(?:\d+\s*\n)?(?:\d{1,2}:)?\d{2}:\d{2}|$)/g;
  let match: RegExpExecArray | null;
  while ((match = cueRegex.exec(text)) !== null) {
    const startTime = parseTimecodeToSeconds(match[1]);
    const endTime = parseTimecodeToSeconds(match[2]);
    const body = match[3]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (body && endTime > startTime) {
      segments.push({ startTime, endTime, text: body });
    }
  }

  if (segments.length > 0) {
    return segments.sort((a, b) => a.startTime - b.startTime);
  }

  // 2. Check inline timestamp markers: [00:15] text or [01:02:15] text or (00:15) text
  const markerRegex = /[\[(](\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)[\])]\s*([^\[\(]+)/g;
  const rawMarkers: Array<{ startTime: number; text: string }> = [];
  while ((match = markerRegex.exec(text)) !== null) {
    const startTime = parseTimecodeToSeconds(match[1]);
    const body = match[2].replace(/\s+/g, ' ').trim();
    if (body) {
      rawMarkers.push({ startTime, text: body });
    }
  }

  if (rawMarkers.length > 0) {
    for (let i = 0; i < rawMarkers.length; i++) {
      const curr = rawMarkers[i];
      const next = rawMarkers[i + 1];
      const estimatedEnd = next ? Math.max(curr.startTime + 1, next.startTime) : curr.startTime + 8;
      segments.push({
        startTime: curr.startTime,
        endTime: estimatedEnd,
        text: curr.text,
      });
    }
    return segments;
  }

  return [];
}

/**
 * Probe video container for embedded subtitle streams and extract SRT if present
 */
export async function probeAndExtractEmbeddedSubtitles(
  videoPath: string
): Promise<{ found: boolean; rawSrt?: string; language?: string }> {
  try {
    const probeCmd = `ffprobe -v error -select_streams s -show_entries stream=index,codec_name:stream_tags=language -of json "${videoPath}"`;
    const { stdout } = await execAsync(probeCmd);
    const data = JSON.parse(stdout || '{}');
    const streams = data.streams || [];

    if (streams.length === 0) {
      return { found: false };
    }

    const extractCmd = `ffmpeg -v error -i "${videoPath}" -map 0:s:0 -f srt -`;
    const { stdout: srtText } = await execAsync(extractCmd, { maxBuffer: 5 * 1024 * 1024 });
    if (srtText && srtText.trim().length > 10) {
      return {
        found: true,
        rawSrt: srtText.trim(),
        language: streams[0]?.tags?.language || 'unknown',
      };
    }
    return { found: false };
  } catch {
    return { found: false };
  }
}

/**
 * Probe whether audio stream has active signal (not completely silent)
 */
export async function probeAudioSignalActivity(
  videoPath: string,
  hasAudio: boolean
): Promise<{ audioActive: boolean; meanVolumeDb?: number }> {
  if (!hasAudio) {
    return { audioActive: false };
  }
  try {
    // Check first 60s of audio to gauge real volume levels fast
    const cmd = `ffmpeg -v info -t 60 -i "${videoPath}" -af "volumedetect" -vn -f null - 2>&1`;
    const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 4 * 1024 * 1024 });
    const output = (stdout || '') + (stderr || '');
    const meanMatch = output.match(/mean_volume:\s*([-0-9.]+)\s*dB/);
    const maxMatch = output.match(/max_volume:\s*([-0-9.]+)\s*dB/);

    const meanDb = meanMatch ? parseFloat(meanMatch[1]) : undefined;
    const maxDb = maxMatch ? parseFloat(maxMatch[1]) : undefined;

    // A completely silent audio track typically has max_volume <= -70dB
    const audioActive = maxDb !== undefined ? maxDb > -65 : true;
    return { audioActive, meanVolumeDb: meanDb };
  } catch {
    return { audioActive: hasAudio };
  }
}

export interface VerifiedTranscriptContext {
  verification: TranscriptVerificationInfo;
  rawTranscript: string;
  segments: TranscriptSegment[];
}

/**
 * Verify transcription availability honestly without fabricating speech analysis
 */
export async function verifyAndPrepareTranscript(params: {
  videoPath: string;
  hasAudio: boolean;
  userTranscript?: string;
  usingVisualFrames: boolean;
}): Promise<VerifiedTranscriptContext> {
  const { videoPath, hasAudio, userTranscript = '', usingVisualFrames } = params;

  const audioProbe = await probeAudioSignalActivity(videoPath, hasAudio);
  const trimmedUser = userTranscript.trim();

  if (trimmedUser.length > 0) {
    const segments = parseTimestampedTranscript(trimmedUser);
    const evidenceMode = usingVisualFrames ? 'combined' : 'transcript_only';
    return {
      verification: {
        hasAudio,
        audioActive: audioProbe.audioActive,
        audioMeanVolumeDb: audioProbe.meanVolumeDb,
        embeddedSubtitlesFound: false,
        transcriptAvailable: true,
        transcriptSource: 'user_provided',
        evidenceMode,
        speechAnalysisClaimed: true,
        segmentsCount: segments.length,
        alignedSegmentsCount: 0,
        notes:
          segments.length > 0
            ? `User-provided timestamped transcript verified (${segments.length} timed segments). Combined visual + speech alignment active.`
            : 'User-provided untimestamped transcript verified. Combined visual + text context active.',
      },
      rawTranscript: trimmedUser,
      segments,
    };
  }

  // Check embedded subtitle track in container
  const embedded = await probeAndExtractEmbeddedSubtitles(videoPath);
  if (embedded.found && embedded.rawSrt) {
    const segments = parseTimestampedTranscript(embedded.rawSrt);
    const evidenceMode = usingVisualFrames ? 'combined' : 'transcript_only';
    return {
      verification: {
        hasAudio,
        audioActive: audioProbe.audioActive,
        audioMeanVolumeDb: audioProbe.meanVolumeDb,
        embeddedSubtitlesFound: true,
        transcriptAvailable: true,
        transcriptSource: 'embedded_subtitles',
        evidenceMode,
        speechAnalysisClaimed: true,
        segmentsCount: segments.length,
        alignedSegmentsCount: 0,
        notes: `Extracted embedded subtitle track (${embedded.language || 'default'}, ${segments.length} timed segments). Combined visual + subtitle alignment active.`,
      },
      rawTranscript: embedded.rawSrt,
      segments,
    };
  }

  // No transcript provided and no embedded subtitles: be 100% honest
  const evidenceMode = usingVisualFrames ? 'visual_only' : 'transcript_only';
  const notes = hasAudio
    ? `Audio stream detected${audioProbe.meanVolumeDb !== undefined ? ` (mean ${audioProbe.meanVolumeDb.toFixed(1)} dB)` : ''}, but no timestamped transcript or embedded caption track was provided/available. Analysis used visual frames only; speech transcription was NOT claimed or fabricated.`
    : 'No audio track or transcript present. Analysis used visual frames only.';

  return {
    verification: {
      hasAudio,
      audioActive: audioProbe.audioActive,
      audioMeanVolumeDb: audioProbe.meanVolumeDb,
      embeddedSubtitlesFound: false,
      transcriptAvailable: false,
      transcriptSource: 'none',
      evidenceMode,
      speechAnalysisClaimed: false,
      segmentsCount: 0,
      alignedSegmentsCount: 0,
      notes,
    },
    rawTranscript: '',
    segments: [],
  };
}

/**
 * Align candidate clip boundaries with timestamped transcript segments to preserve complete sentences
 * without violating editorial duration limits or source bounds.
 */
export function alignClipWithTranscriptSegments(params: {
  startTime: number;
  endTime: number;
  videoDuration: number;
  segments: TranscriptSegment[];
  editorialStyle: EditorialCurationStyle;
}): {
  startTime: number;
  endTime: number;
  aligned: boolean;
  transcriptText?: string;
  notes?: string;
} {
  const { startTime, endTime, videoDuration, segments, editorialStyle } = params;
  if (!segments || segments.length === 0) {
    return { startTime, endTime, aligned: false };
  }

  const overlapping = segments.filter(
    (s) => s.endTime > startTime + 0.3 && s.startTime < endTime - 0.3
  );

  if (overlapping.length === 0) {
    return { startTime, endTime, aligned: false };
  }

  const firstSeg = overlapping[0];
  const lastSeg = overlapping[overlapping.length - 1];
  const policy = getEditorialPolicy(editorialStyle);

  let adjStart = startTime;
  let adjEnd = endTime;
  let aligned = false;
  const notes: string[] = [];

  // Snap backward slightly (<= 2.5s) to preserve complete opening sentence if clipped mid-cue
  if (firstSeg.startTime < startTime && startTime - firstSeg.startTime <= 2.5) {
    const candidateStart = Math.max(0, firstSeg.startTime);
    if (adjEnd - candidateStart <= policy.maxDuration) {
      adjStart = Math.round(candidateStart * 10) / 10;
      aligned = true;
      notes.push(`Aligned start to sentence boundary (${adjStart.toFixed(1)}s)`);
    }
  }

  // Snap forward slightly (<= 3.0s) to preserve complete closing sentence payoff
  if (lastSeg.endTime > endTime && lastSeg.endTime - endTime <= 3.0) {
    const candidateEnd = Math.min(videoDuration, lastSeg.endTime);
    if (candidateEnd - adjStart <= policy.maxDuration) {
      adjEnd = Math.round(candidateEnd * 10) / 10;
      aligned = true;
      notes.push(`Aligned end to sentence completion (${adjEnd.toFixed(1)}s)`);
    }
  }

  const transcriptText = overlapping.map((s) => s.text).join(' ').trim();

  return {
    startTime: adjStart,
    endTime: adjEnd,
    aligned,
    transcriptText: transcriptText || undefined,
    notes: notes.length > 0 ? notes.join('; ') : undefined,
  };
}
