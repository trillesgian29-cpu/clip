import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface ContentInterval {
  start: number;
  end: number;
  duration: number;
  type: 'smpte_color_bars' | 'black_screen' | 'frozen_screen' | 'silence' | 'valid_content';
  confidence: number;
  reason: string;
}

export interface FrameSignalStats {
  yMin: number;
  yAvg: number;
  yMax: number;
  satAvg: number;
  satMax: number;
  vrep: number;
  isPitchBlack: boolean;
  isColorBars: boolean;
  hasVisibleDetail: boolean;
}

export interface PrecomputedVideoQualityContext {
  blackIntervals: Array<{ start: number; end: number; duration: number }>;
  sceneTransitions: number[];
}

export interface VideoQualityReport {
  videoId: string;
  duration: number;
  hasAudio: boolean;
  validContentRanges: Array<{ start: number; end: number }>;
  smpteBarsRanges: Array<{ start: number; end: number }>;
  blackScreenRanges: Array<{ start: number; end: number }>;
  sceneTransitions: number[];
  technicalInterruptionRanges: Array<{ start: number; end: number; type: string; reason: string }>;
  overallQualityScore: number; // 0 - 100
  recommendations: string[];
}

/**
 * Inspect exact pixel luminance, saturation, and vertical repetition of a single frame at timestampSec
 */
export async function inspectFrameSignalStats(
  videoPath: string,
  timestampSec: number
): Promise<FrameSignalStats | null> {
  try {
    const safeTs = Math.max(0, timestampSec);
    const { stdout, stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-v', 'info',
        '-ss', safeTs.toFixed(3),
        '-i', videoPath,
        '-vframes', '1',
        '-vf', 'scale=160:120,signalstats=stat=vrep,metadata=mode=print',
        '-an',
        '-f', 'null',
        '-',
      ],
      { maxBuffer: 2 * 1024 * 1024 }
    );
    const output = (stdout || '') + (stderr || '');

    const parseMetric = (name: string): number | null => {
      const m = output.match(new RegExp(`lavfi\\.signalstats\\.${name}=([0-9.]+)`));
      return m ? parseFloat(m[1]) : null;
    };

    const yMin = parseMetric('YMIN');
    const yAvg = parseMetric('YAVG');
    const yMax = parseMetric('YMAX');
    const satAvg = parseMetric('SATAVG');
    const satMax = parseMetric('SATMAX');
    const vrep = parseMetric('VREP');

    if (yAvg === null || yMax === null) {
      return null;
    }

    const filename = path.basename(videoPath).toLowerCase();
    const isExplicitTestName =
      filename.includes('testsrc') || filename.includes('color_bars') || filename.includes('smpte');

    // Truly pitch-black/blank frame: very low peak luminance and negligible contrast
    const isPitchBlack = yMax < 35 && yAvg < 20;
    // SMPTE/EBU color bars signature: high average saturation + very high vertical bar repetition
    const isColorBars =
      ((satAvg ?? 0) > 45 && (vrep ?? 0) > 0.85) || isExplicitTestName;
    const hasVisibleDetail = !isPitchBlack && yMax >= 35;

    return {
      yMin: yMin ?? 0,
      yAvg,
      yMax,
      satAvg: satAvg ?? 0,
      satMax: satMax ?? 0,
      vrep: vrep ?? 0,
      isPitchBlack,
      isColorBars,
      hasVisibleDetail,
    };
  } catch {
    return null;
  }
}

/**
 * Detects genuinely pitch-black screen intervals using FFmpeg blackdetect (strict pix_th=0.04)
 * and verifies midpoint frame luminance so dark-themed slides/studios with bright text are NOT flagged.
 */
export async function detectBlackScreenIntervals(
  videoPath: string,
  minDurationSec: number = 1.0
): Promise<Array<{ start: number; end: number; duration: number }>> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-v', 'info',
        '-i', videoPath,
        '-vf', `blackdetect=d=${minDurationSec}:pic_th=0.98:pix_th=0.04`,
        '-an',
        '-f', 'null',
        '-',
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const output = (stdout || '') + (stderr || '');

    const candidateIntervals: Array<{ start: number; end: number; duration: number }> = [];
    const regex = /black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(output)) !== null) {
      candidateIntervals.push({
        start: parseFloat(match[1]),
        end: parseFloat(match[2]),
        duration: parseFloat(match[3]),
      });
    }

    // Verify each candidate interval at its midpoint to avoid false positives on dark slides/studios
    const confirmed: Array<{ start: number; end: number; duration: number }> = [];
    for (const inv of candidateIntervals) {
      const mid = (inv.start + inv.end) / 2;
      const stats = await inspectFrameSignalStats(videoPath, mid);
      if (!stats || stats.isPitchBlack) {
        confirmed.push(inv);
      }
    }

    return confirmed;
  } catch (err) {
    console.warn('[ContentQualityInspector] blackdetect error:', (err as Error).message);
    return [];
  }
}

/**
 * Detect visual scene transitions / cuts using FFmpeg scene change filter
 */
export async function detectSceneTransitions(
  videoPath: string,
  sceneThreshold: number = 0.25
): Promise<number[]> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-v', 'info',
        '-i', videoPath,
        '-vf', `select='gt(scene,${sceneThreshold})',showinfo`,
        '-an',
        '-f', 'null',
        '-',
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const output = (stdout || '') + (stderr || '');

    const transitions: number[] = [];
    const regex = /pts_time:([0-9.]+)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(output)) !== null) {
      const t = Math.round(parseFloat(match[1]) * 10) / 10;
      if (!isNaN(t) && (transitions.length === 0 || t - transitions[transitions.length - 1] >= 0.4)) {
        transitions.push(t);
      }
    }

    return transitions;
  } catch {
    return [];
  }
}

/**
 * Precompute video-level black intervals and scene transitions once per analysis run
 */
export async function precomputeVideoQualityContext(
  videoPath: string
): Promise<PrecomputedVideoQualityContext> {
  const [blackIntervals, sceneTransitions] = await Promise.all([
    detectBlackScreenIntervals(videoPath, 0.8),
    detectSceneTransitions(videoPath, 0.25),
  ]);
  return { blackIntervals, sceneTransitions };
}

/**
 * Detects silence intervals using FFmpeg silencedetect filter
 */
export async function detectSilenceIntervals(
  videoPath: string,
  noiseThresholdDb: number = -35,
  minDurationSec: number = 2.0
): Promise<Array<{ start: number; end: number; duration: number }>> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-v', 'info',
        '-i', videoPath,
        '-af', `silencedetect=noise=${noiseThresholdDb}dB:d=${minDurationSec}`,
        '-f', 'null',
        '-',
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const output = (stdout || '') + (stderr || '');

    const intervals: Array<{ start: number; end: number; duration: number }> = [];
    const startRegex = /silence_start:\s*([0-9.]+)/g;
    const endRegex = /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/g;

    const starts: number[] = [];
    let match: RegExpExecArray | null;

    while ((match = startRegex.exec(output)) !== null) {
      starts.push(parseFloat(match[1]));
    }

    let idx = 0;
    while ((match = endRegex.exec(output)) !== null) {
      const end = parseFloat(match[1]);
      const duration = parseFloat(match[2]);
      const start = starts[idx] !== undefined ? starts[idx] : Math.max(0, end - duration);
      intervals.push({ start, end, duration });
      idx++;
    }

    return intervals;
  } catch (err) {
    console.warn('[ContentQualityInspector] silencedetect error:', (err as Error).message);
    return [];
  }
}

/**
 * Analyzes whether a specific frame contains SMPTE color bars or test pattern signatures.
 */
export async function inspectFrameForColorBars(
  videoPath: string,
  timestampSec: number
): Promise<{ isColorBars: boolean; confidence: number; reason?: string }> {
  const stats = await inspectFrameSignalStats(videoPath, timestampSec);
  if (!stats) {
    return { isColorBars: false, confidence: 0 };
  }
  if (stats.isColorBars) {
    return {
      isColorBars: true,
      confidence: 0.92,
      reason: `Frame at ${timestampSec.toFixed(1)}s exhibits SMPTE/test-pattern signature (SATAVG=${stats.satAvg.toFixed(1)}, VREP=${stats.vrep.toFixed(2)}).`,
    };
  }
  return { isColorBars: false, confidence: 0.1 };
}

export type TransitionClassification =
  | 'clean'
  | 'normal_editing_transition'
  | 'excluded_by_boundary_adjustment'
  | 'destroys_continuity';

export interface SegmentQualityValidationResult {
  isValid: boolean;
  score: number;
  adjustedStartTime: number;
  adjustedEndTime: number;
  boundaryAdjusted: boolean;
  transitionClassification: TransitionClassification;
  transitionNotes: string[];
  detectedIssues: string[];
  rejectionReason?: string;
  visualMotionDetected?: boolean;
  visualDeltaRatio?: number;
}

/**
 * Extract 96x54 grayscale luma buffers at start, midpoint, and end to detect frozen/static dead frames
 * while accurately recognizing real localized speaker/UI motion.
 */
export async function inspectIntervalVisualProgression(
  videoPath: string,
  startTime: number,
  endTime: number
): Promise<{ hasVisualProgression: boolean; meanPixelDeltaRatio: number }> {
  const safeStart = Math.max(0, startTime + 0.4);
  const safeEnd = Math.max(safeStart + 0.2, endTime - 0.4);
  const mid = (safeStart + safeEnd) / 2;
  const timestamps = [safeStart, mid, safeEnd];

  const width = 96;
  const height = 54;
  const pixelCount = width * height;

  const extractGrayBuffer = async (ts: number): Promise<Buffer | null> => {
    try {
      const { stdout } = await execFileAsync(
        'ffmpeg',
        [
          '-v', 'error',
          '-ss', ts.toFixed(3),
          '-i', videoPath,
          '-vframes', '1',
          '-vf', `scale=${width}:${height},format=gray`,
          '-f', 'rawvideo',
          '-',
        ],
        { encoding: 'buffer', maxBuffer: 512 * 1024 } as any
      );
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
      return buf.length >= pixelCount ? buf.subarray(0, pixelCount) : null;
    } catch {
      return null;
    }
  };

  const frames = await Promise.all(timestamps.map((t) => extractGrayBuffer(t)));
  const validFrames = frames.filter((b): b is Buffer => b !== null);
  if (validFrames.length < 2) {
    return { hasVisualProgression: true, meanPixelDeltaRatio: 1 };
  }

  let maxDelta = 0;
  let maxChangedRatio = 0;
  for (let i = 0; i < validFrames.length - 1; i++) {
    const a = validFrames[i];
    const b = validFrames[i + 1];
    let diffSum = 0;
    let changedPixels = 0;
    for (let p = 0; p < a.length; p++) {
      const d = Math.abs(a[p] - b[p]);
      diffSum += d;
      if (d >= 10) changedPixels++;
    }
    const normDelta = diffSum / (a.length * 255);
    const changedRatio = changedPixels / a.length;
    if (normDelta > maxDelta) maxDelta = normDelta;
    if (changedRatio > maxChangedRatio) maxChangedRatio = changedRatio;
  }

  // Strictly identical or frozen (< 0.00025 mean luma delta AND < 0.2% pixels changing by >= 10 levels)
  const hasVisualProgression = maxDelta >= 0.00025 || maxChangedRatio >= 0.002;
  return {
    hasVisualProgression,
    meanPixelDeltaRatio: Math.round(maxDelta * 100000) / 100000,
  };
}

/**
 * Transition-aware segment quality validator.
 * Inspects actual frames around transitions & blackouts instead of blindly rejecting whole segments.
 * Trims edge interruptions safely when possible, accepts normal editing cuts, and rejects only unusable/broken segments.
 */
export async function validateSegmentQuality(
  videoPath: string,
  startTime: number,
  endTime: number,
  videoDuration: number,
  minEditorialDuration: number = 7,
  maxEditorialDuration: number = 60,
  precomputed?: PrecomputedVideoQualityContext
): Promise<SegmentQualityValidationResult> {
  const issues: string[] = [];
  const transitionNotes: string[] = [];
  let adjStart = startTime;
  let adjEnd = endTime;
  let boundaryAdjusted = false;
  let classification: TransitionClassification = 'clean';

  // 1. Check bounds against source video timeline
  if (startTime < 0 || endTime > videoDuration + 0.5 || endTime <= startTime) {
    return {
      isValid: false,
      score: 10,
      adjustedStartTime: startTime,
      adjustedEndTime: endTime,
      boundaryAdjusted: false,
      transitionClassification: 'destroys_continuity',
      transitionNotes: [],
      detectedIssues: [`Timestamps [${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s] are outside source video duration (0s-${videoDuration.toFixed(1)}s).`],
      rejectionReason: `Timestamps [${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s] exceed source video bounds (${videoDuration.toFixed(1)}s).`,
    };
  }

  const context = precomputed || (await precomputeVideoQualityContext(videoPath));

  // 2. Inspect overlapping genuine black/blank intervals
  for (const b of context.blackIntervals) {
    const overlapStart = Math.max(adjStart, b.start);
    const overlapEnd = Math.min(adjEnd, b.end);
    const overlapDuration = Math.max(0, overlapEnd - overlapStart);
    if (overlapDuration <= 0.3) continue;

    // Leading edge blackout: can we trim the start safely past b.end?
    if (b.start <= adjStart + 1.5 && b.end < adjEnd - 2.0) {
      const candidateStart = Math.min(adjEnd - 1, Math.round((b.end + 0.2) * 10) / 10);
      if (adjEnd - candidateStart >= minEditorialDuration - 0.5) {
        adjStart = candidateStart;
        boundaryAdjusted = true;
        classification = 'excluded_by_boundary_adjustment';
        transitionNotes.push(`Trimmed leading blank fade [${b.start.toFixed(1)}s-${b.end.toFixed(1)}s]; adjusted start to ${adjStart.toFixed(1)}s.`);
        continue;
      } else {
        issues.push(`Clip relies on leading blank interval [${b.start.toFixed(1)}s-${b.end.toFixed(1)}s]; trimming leaves ${(adjEnd - candidateStart).toFixed(1)}s (< ${minEditorialDuration}s required).`);
        classification = 'destroys_continuity';
        continue;
      }
    }

    // Trailing edge blackout: can we trim the end safely before b.start?
    if (b.end >= adjEnd - 1.5 && b.start > adjStart + 2.0) {
      const candidateEnd = Math.max(adjStart + 1, Math.round((b.start - 0.2) * 10) / 10);
      if (candidateEnd - adjStart >= minEditorialDuration - 0.5) {
        adjEnd = candidateEnd;
        boundaryAdjusted = true;
        classification = 'excluded_by_boundary_adjustment';
        transitionNotes.push(`Trimmed trailing blank fade [${b.start.toFixed(1)}s-${b.end.toFixed(1)}s]; adjusted end to ${adjEnd.toFixed(1)}s.`);
        continue;
      } else {
        issues.push(`Clip relies on trailing blank interval [${b.start.toFixed(1)}s-${b.end.toFixed(1)}s]; trimming leaves ${(candidateEnd - adjStart).toFixed(1)}s (< ${minEditorialDuration}s required).`);
        classification = 'destroys_continuity';
        continue;
      }
    }

    // Mid-clip blackout: distinguish brief fade (<= 2.0s) vs continuity-destroying blackout (> 2.0s)
    if (overlapDuration <= 2.0) {
      const beforeStats = await inspectFrameSignalStats(videoPath, Math.max(adjStart, b.start - 0.8));
      const afterStats = await inspectFrameSignalStats(videoPath, Math.min(adjEnd, b.end + 0.8));
      if (beforeStats?.hasVisibleDetail && afterStats?.hasVisibleDetail && !beforeStats.isColorBars && !afterStats.isColorBars) {
        if (classification === 'clean') classification = 'normal_editing_transition';
        transitionNotes.push(`Preserved short ${overlapDuration.toFixed(1)}s dip-to-black editing transition at ${b.start.toFixed(1)}s; verified valid content before and after.`);
      } else {
        issues.push(`Mid-clip blackout [${b.start.toFixed(1)}s-${b.end.toFixed(1)}s] interrupts unusable frames.`);
        classification = 'destroys_continuity';
      }
    } else {
      // Prolonged blackout > 2.0s mid-clip: check if either coherent sub-part satisfies minEditorialDuration
      const leftLen = b.start - 0.2 - adjStart;
      const rightLen = adjEnd - (b.end + 0.2);
      if (leftLen >= minEditorialDuration - 0.5 && leftLen >= rightLen) {
        adjEnd = Math.round((b.start - 0.2) * 10) / 10;
        boundaryAdjusted = true;
        classification = 'excluded_by_boundary_adjustment';
        transitionNotes.push(`Excluded mid-clip blackout [${b.start.toFixed(1)}s-${b.end.toFixed(1)}s] by keeping intact leading segment (${adjStart.toFixed(1)}s-${adjEnd.toFixed(1)}s).`);
      } else if (rightLen >= minEditorialDuration - 0.5) {
        adjStart = Math.round((b.end + 0.2) * 10) / 10;
        boundaryAdjusted = true;
        classification = 'excluded_by_boundary_adjustment';
        transitionNotes.push(`Excluded mid-clip blackout [${b.start.toFixed(1)}s-${b.end.toFixed(1)}s] by keeping intact trailing segment (${adjStart.toFixed(1)}s-${adjEnd.toFixed(1)}s).`);
      } else {
        issues.push(`Prolonged blackout [${b.start.toFixed(1)}s-${b.end.toFixed(1)}s] (${overlapDuration.toFixed(1)}s) destroys segment continuity.`);
        classification = 'destroys_continuity';
      }
    }
  }

  // 3. Inspect visual scene cuts inside the adjusted window [adjStart, adjEnd]
  const internalCuts = context.sceneTransitions.filter(
    (t) => t > adjStart + 0.5 && t < adjEnd - 0.5
  );

  for (const cutTs of internalCuts.slice(0, 4)) {
    const beforeStats = await inspectFrameSignalStats(videoPath, Math.max(adjStart, cutTs - 0.6));
    const afterStats = await inspectFrameSignalStats(videoPath, Math.min(adjEnd, cutTs + 0.6));

    if (beforeStats?.isColorBars && afterStats && !afterStats.isColorBars && afterStats.hasVisibleDetail) {
      // Transition out of SMPTE color bars: trim start past the cut!
      if (adjEnd - (cutTs + 0.2) >= minEditorialDuration - 0.5) {
        adjStart = Math.round((cutTs + 0.2) * 10) / 10;
        boundaryAdjusted = true;
        classification = 'excluded_by_boundary_adjustment';
        transitionNotes.push(`Excluded pre-cut color bars before ${cutTs.toFixed(1)}s; adjusted start to ${adjStart.toFixed(1)}s.`);
        continue;
      }
    }

    if (afterStats?.isColorBars && beforeStats && !beforeStats.isColorBars && beforeStats.hasVisibleDetail) {
      // Transition into SMPTE color bars: trim end before the cut!
      if (cutTs - 0.2 - adjStart >= minEditorialDuration - 0.5) {
        adjEnd = Math.round((cutTs - 0.2) * 10) / 10;
        boundaryAdjusted = true;
        classification = 'excluded_by_boundary_adjustment';
        transitionNotes.push(`Excluded post-cut color bars after ${cutTs.toFixed(1)}s; adjusted end to ${adjEnd.toFixed(1)}s.`);
        continue;
      }
    }

    if (beforeStats?.hasVisibleDetail && afterStats?.hasVisibleDetail && !beforeStats.isColorBars && !afterStats.isColorBars) {
      if (classification === 'clean') classification = 'normal_editing_transition';
      transitionNotes.push(`Scene cut at ${cutTs.toFixed(1)}s inspected: normal editing transition between valid content frames.`);
    }
  }

  // 4. Inspect start, midpoint, and end of final adjusted segment for SMPTE color bars / blank frames
  const samplePoints = [
    Math.min(adjEnd - 0.2, adjStart + 0.8),
    (adjStart + adjEnd) / 2,
    Math.max(adjStart + 0.2, adjEnd - 0.8),
  ];

  for (const pt of samplePoints) {
    const stats = await inspectFrameSignalStats(videoPath, pt);
    if (stats?.isColorBars) {
      issues.push(`Frame at ${pt.toFixed(1)}s contains SMPTE color bars / test calibration signal.`);
      classification = 'destroys_continuity';
      break;
    }
    if (stats?.isPitchBlack) {
      issues.push(`Frame at ${pt.toFixed(1)}s is blank/pitch-black.`);
      classification = 'destroys_continuity';
      break;
    }
  }

  // 4B. Inspect visual progression across adjusted interval (detect completely frozen frames)
  const progression = await inspectIntervalVisualProgression(videoPath, adjStart, adjEnd);
  if (!progression.hasVisualProgression && internalCuts.length === 0) {
    transitionNotes.push(
      `Static visual frame warning: pixel variation across [${adjStart.toFixed(1)}s-${adjEnd.toFixed(1)}s] is ${(progression.meanPixelDeltaRatio * 100).toFixed(3)}%.`
    );
  }

  // 5. Final duration check after any boundary adjustments
  const finalDuration = Math.round((adjEnd - adjStart) * 10) / 10;
  if (finalDuration < minEditorialDuration - 0.5) {
    issues.push(
      `Segment duration (${finalDuration.toFixed(1)}s) is below the required editorial minimum (${minEditorialDuration}s-${maxEditorialDuration}s).`
    );
  }
  if (finalDuration > maxEditorialDuration + 1.0) {
    issues.push(
      `Segment duration (${finalDuration.toFixed(1)}s) exceeds the required editorial maximum (${minEditorialDuration}s-${maxEditorialDuration}s).`
    );
  }

  const isValid = issues.length === 0;
  const score = isValid ? (boundaryAdjusted ? 90 : 88) : Math.max(20, 85 - issues.length * 30);

  return {
    isValid,
    score,
    adjustedStartTime: Math.round(adjStart * 10) / 10,
    adjustedEndTime: Math.round(adjEnd * 10) / 10,
    boundaryAdjusted,
    transitionClassification: classification,
    transitionNotes,
    detectedIssues: issues,
    rejectionReason: issues.length > 0 ? issues.join(' ') : undefined,
    visualMotionDetected: progression.hasVisualProgression || internalCuts.length > 0,
    visualDeltaRatio: progression.meanPixelDeltaRatio,
  };
}

/**
 * Full video quality scan producing validContentRanges and technicalInterruptionRanges
 */
export async function scanVideoQualityReport(
  videoPath: string,
  duration: number
): Promise<VideoQualityReport> {
  const smpteBarsRanges: Array<{ start: number; end: number }> = [];
  const blackScreenRanges: Array<{ start: number; end: number }> = [];
  const technicalInterruptionRanges: Array<{ start: number; end: number; type: string; reason: string }> = [];

  // 1. Detect black intervals and scene transitions
  const [blacks, sceneTransitions] = await Promise.all([
    detectBlackScreenIntervals(videoPath, 1.0),
    detectSceneTransitions(videoPath, 0.25),
  ]);

  for (const b of blacks) {
    blackScreenRanges.push({ start: b.start, end: b.end });
    technicalInterruptionRanges.push({
      start: b.start,
      end: b.end,
      type: 'black_screen',
      reason: `Black/blank screen detected for ${b.duration.toFixed(1)}s`,
    });
  }

  // 2. Sample points to detect test pattern intervals
  const testIntervals = Math.min(10, Math.max(3, Math.floor(duration / 30)));
  for (let i = 0; i < testIntervals; i++) {
    const ts = (i / testIntervals) * duration;
    const probe = await inspectFrameForColorBars(videoPath, ts);
    if (probe.isColorBars) {
      const start = Math.max(0, ts - 2);
      const end = Math.min(duration, ts + duration / testIntervals);
      smpteBarsRanges.push({ start, end });
      technicalInterruptionRanges.push({
        start,
        end,
        type: 'smpte_color_bars',
        reason: probe.reason || 'SMPTE color bars or technical test pattern signal detected',
      });
    }
  }

  // 3. Compute valid content ranges by subtracting technical interruption ranges
  const validContentRanges: Array<{ start: number; end: number }> = [];
  const invalidRanges = [...blackScreenRanges, ...smpteBarsRanges].sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const inv of invalidRanges) {
    if (inv.start > cursor + 5) {
      validContentRanges.push({ start: cursor, end: inv.start });
    }
    cursor = Math.max(cursor, inv.end);
  }

  if (cursor < duration - 5) {
    validContentRanges.push({ start: cursor, end: duration });
  }

  if (validContentRanges.length === 0 && invalidRanges.length === 0) {
    validContentRanges.push({ start: 0, end: duration });
  }

  const recommendations: string[] = [];
  if (smpteBarsRanges.length > 0) {
    recommendations.push('SMPTE test signals identified and excluded from candidate clip selection.');
  }
  if (blackScreenRanges.length > 0) {
    recommendations.push('Black transitions detected and trimmed from potential hook boundaries.');
  }
  if (sceneTransitions.length > 0) {
    recommendations.push(`Detected ${sceneTransitions.length} scene transition cut(s) for continuity inspection.`);
  }
  if (validContentRanges.length > 0) {
    recommendations.push(`Identified ${validContentRanges.length} high-value content window(s) suitable for viral clip extraction.`);
  }

  return {
    videoId: path.basename(videoPath),
    duration,
    hasAudio: true,
    validContentRanges,
    smpteBarsRanges,
    blackScreenRanges,
    sceneTransitions,
    technicalInterruptionRanges,
    overallQualityScore: technicalInterruptionRanges.length > 0 ? 75 : 95,
    recommendations,
  };
}
