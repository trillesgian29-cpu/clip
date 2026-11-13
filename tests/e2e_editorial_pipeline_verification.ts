import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  DiagnosticReporter,
  extractAiTelemetry,
  redactSensitiveText,
} from './lib/diagnosticReporter.ts';

dotenv.config();

const execFileAsync = promisify(execFile);
const API_BASE = 'http://localhost:3000';
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const TMP_DIR = path.resolve('uploads/tmp_e2e');
const REPORT_PATH = path.resolve('e2e_verification_report.json');

async function runCmd(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { maxBuffer: 10 * 1024 * 1024 });
}

async function generateMultiTopicKeynoteVideo(outPath: string): Promise<void> {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // Build 5 distinct 37-38s visual segments + 1 technical glitch segment (188-196s)
  const segments = [
    {
      idx: 1,
      color: '#111827',
      dur: 37.4,
      title: 'TOPIC 1: WHY 90 PERCENT OF AI STARTUPS FAIL',
      line1: 'Hook: Most founders obsess over model benchmarks.',
      line2: 'Insight: Distribution channels beat raw accuracy every time.',
      line3: 'Payoff: Own the workflow before chasing benchmark leaderboards.',
    },
    {
      idx: 2,
      color: '#1e1b4b',
      dur: 37.4,
      title: 'TOPIC 2: THE 3-SECOND RETENTION HOOK FORMULA',
      line1: 'Hook: You lose 65 percent of viewers before second three.',
      line2: 'Insight: Open with a specific contradiction or visual proof.',
      line3: 'Payoff: Deliver the promised answer within 45 seconds.',
    },
    {
      idx: 3,
      color: '#064e3b',
      dur: 37.4,
      title: 'TOPIC 3: ZERO-LATENCY EDGE VIDEO STREAMING',
      line1: 'Hook: Waiting for full video buffering kills engagement.',
      line2: 'Insight: HTTP 206 byte-range streaming serves frames instantly.',
      line3: 'Payoff: Instant seek scrubbing saves bandwidth and bounce rate.',
    },
    {
      idx: 4,
      color: '#451a03',
      dur: 37.4,
      title: 'TOPIC 4: TURN ONE PODCAST INTO TEN VIRAL CLIPS',
      line1: 'Hook: Stop slicing interviews at arbitrary 30-second timers.',
      line2: 'Insight: Align boundaries to complete question-and-answer arcs.',
      line3: 'Payoff: Complete thoughts double watch-through completion.',
    },
    {
      idx: 5,
      color: '#2e1065',
      dur: 34.4,
      title: 'TOPIC 5: CREATOR BURNOUT AND BATCH PRODUCTION',
      line1: 'Hook: Daily manual editing drains creative momentum.',
      line2: 'Insight: Separate moment curation from batch FFmpeg rendering.',
      line3: 'Payoff: Ship a whole week of shorts in one focused afternoon.',
    },
  ];

  const segFiles: string[] = [];

  for (const seg of segments) {
    const segFile = path.join(TMP_DIR, `seg_${seg.idx}.mp4`);
    const vf = [
      `drawtext=fontfile=${FONT_BOLD}:text='${seg.title}':x=70:y=110:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=10`,
      `drawtext=fontfile=${FONT_REG}:text='${seg.line1}':x=70:y=230:fontsize=28:fontcolor=#fde047:box=1:boxcolor=black@0.55:boxborderw=8`,
      `drawtext=fontfile=${FONT_REG}:text='${seg.line2}':x=70:y=320:fontsize=28:fontcolor=#67e8f9:box=1:boxcolor=black@0.55:boxborderw=8`,
      `drawtext=fontfile=${FONT_REG}:text='${seg.line3}':x=70:y=410:fontsize=28:fontcolor=#86efac:box=1:boxcolor=black@0.55:boxborderw=8`,
      `drawtext=fontfile=${FONT_REG}:text='Chapter ${seg.idx}  Timecode %{pts\\:hms}':x=70:y=560:fontsize=24:fontcolor=#e2e8f0`,
    ].join(',');

    await runCmd('ffmpeg', [
      '-f', 'lavfi', '-i', `color=c=${seg.color}:size=1280x720:duration=${seg.dur}:rate=24`,
      '-f', 'lavfi', '-i', `aevalsrc=sin(${200 + seg.idx * 55}*2*PI*t)*0.18:d=${seg.dur}`,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k',
      '-y', segFile,
    ]);
    segFiles.push(segFile);

    // Add a brief 0.6s cross-chapter slate transition between chapters 1..4 so transition handling is exercised
    if (seg.idx <= 4) {
      const transFile = path.join(TMP_DIR, `trans_${seg.idx}.mp4`);
      await runCmd('ffmpeg', [
        '-f', 'lavfi', '-i', `color=c=#020617:size=1280x720:duration=0.6:rate=24`,
        '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono`,
        '-t', '0.6',
        '-vf', `drawtext=fontfile=${FONT_BOLD}:text='NEXT CHAPTER >>>':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=38:fontcolor=white`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k',
        '-y', transFile,
      ]);
      segFiles.push(transFile);
    }
  }

  // Add technical glitch (4s SMPTE color bars + 4s black screen at ~186.4s to 194.4s)
  const smpteFile = path.join(TMP_DIR, 'seg_smpte.mp4');
  await runCmd('ffmpeg', [
    '-f', 'lavfi', '-i', 'smptebars=size=1280x720:duration=4:rate=24',
    '-f', 'lavfi', '-i', 'aevalsrc=sin(1000*2*PI*t)*0.1:d=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-y', smpteFile,
  ]);
  segFiles.push(smpteFile);

  const blackFile = path.join(TMP_DIR, 'seg_black.mp4');
  await runCmd('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=c=black:size=1280x720:duration=4:rate=24',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-t', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-y', blackFile,
  ]);
  segFiles.push(blackFile);

  // Concat video segments
  const concatListPath = path.join(TMP_DIR, 'concat_list.txt');
  fs.writeFileSync(concatListPath, segFiles.map((f) => `file '${f}'`).join('\n'));

  const mergedNoSubPath = path.join(TMP_DIR, 'merged_no_sub.mp4');
  await runCmd('ffmpeg', [
    '-f', 'concat', '-safe', '0', '-i', concatListPath,
    '-c', 'copy',
    '-y', mergedNoSubPath,
  ]);

  // Create embedded SRT subtitles aligned precisely with each topic
  const srtPath = path.join(TMP_DIR, 'keynote.srt');
  const srtContent = `1
00:00:01,000 --> 00:00:12,000
Most AI startup founders obsess over benchmark percentages while ignoring distribution.

2
00:00:12,500 --> 00:00:25,000
In reality, distribution channels beat raw model accuracy every single time in production.

3
00:00:25,500 --> 00:00:36,500
Own the daily customer workflow before chasing public benchmark leaderboards.

4
00:00:39,000 --> 00:00:50,000
You lose 65 percent of short-form viewers before the first three seconds finish.

5
00:00:50,500 --> 00:01:03,000
Always open frame one with a sharp contradiction or undeniable visual proof.

6
00:01:03,500 --> 00:01:14,500
Then deliver the promised payoff cleanly inside forty-five seconds.

7
00:01:17,000 --> 00:01:29,000
Waiting for a full MP4 download kills viewer retention on mobile networks.

8
00:01:29,500 --> 00:01:42,000
HTTP 206 byte-range streaming serves exact keyframes instantaneously when seeking.

9
00:01:42,500 --> 00:01:52,500
Instant timeline scrubbing slashes server bandwidth and drops bounce rate in half.

10
00:01:55,000 --> 00:02:07,000
Stop slicing long podcasts at arbitrary thirty-second timer intervals.

11
00:02:07,500 --> 00:02:20,000
Align clip boundaries to complete question-and-answer arcs with full context.

12
00:02:20,500 --> 00:02:31,000
Complete standalone thoughts double your average watch-through completion rate.

13
00:02:33,500 --> 00:02:45,000
Daily manual timeline trimming drains creative energy for solo creators.

14
00:02:45,500 --> 00:02:56,000
Separate semantic moment curation from automated FFmpeg batch rendering.

15
00:02:56,500 --> 00:03:05,500
Ship an entire week of vertical shorts in one focused afternoon session.
`;
  fs.writeFileSync(srtPath, srtContent, 'utf8');

  await runCmd('ffmpeg', [
    '-i', mergedNoSubPath,
    '-i', srtPath,
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-c:s', 'mov_text',
    '-movflags', '+faststart',
    '-y', outPath,
  ]);
}

async function generateShortInsufficientVideo(outPath: string): Promise<void> {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  await runCmd('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=c=#1e293b:size=1280x720:duration=12:rate=24',
    '-f', 'lavfi', '-i', 'aevalsrc=sin(260*2*PI*t)*0.15:d=12',
    '-vf', `drawtext=fontfile=${FONT_BOLD}:text='QUICK 12S UPDATE CLIP':x=80:y=260:fontsize=42:fontcolor=white`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    '-y', outPath,
  ]);
}

async function generateVisualOnlyVideo(outPath: string): Promise<void> {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const chapters = [
    {
      idx: 1,
      color: '#0f172a',
      title: 'DEMO 1: ZERO-BUFFER FRAME SEEKING',
      sub: 'Step 1 -> Seek keyframes directly on NVMe storage',
      detail: 'Result -> Sub-50ms preview scrub across 2-hour timelines',
    },
    {
      idx: 2,
      color: '#1e1b4b',
      title: 'DEMO 2: SMART VERTICAL 9:16 AUTO-CROP',
      sub: 'Step 2 -> Track active speaker coordinates per frame',
      detail: 'Result -> Crisp mobile framing without clipped heads',
    },
    {
      idx: 3,
      color: '#064e3b',
      title: 'DEMO 3: PARALLEL FFMPEG RENDER PIPELINE',
      sub: 'Step 3 -> Queue 4 independent MP4 exports concurrently',
      detail: 'Result -> Ready-to-post TikTok, Shorts & Reels files',
    },
  ];

  const parts: string[] = [];
  for (const ch of chapters) {
    const partPath = path.join(TMP_DIR, `vis_part_${ch.idx}.mp4`);
    const vf = [
      `drawtext=fontfile=${FONT_BOLD}:text='${ch.title}':x=70:y=150:fontsize=38:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=10`,
      `drawtext=fontfile=${FONT_REG}:text='${ch.sub}':x=70:y=270:fontsize=28:fontcolor=#38bdf8:box=1:boxcolor=black@0.55:boxborderw=8`,
      `drawtext=fontfile=${FONT_REG}:text='${ch.detail}':x=70:y=370:fontsize=28:fontcolor=#86efac:box=1:boxcolor=black@0.55:boxborderw=8`,
      `drawtext=fontfile=${FONT_REG}:text='Visual Beat ${ch.idx}  Time %{pts\\:hms}':x=70:y=520:fontsize=24:fontcolor=white`,
    ].join(',');
    await runCmd('ffmpeg', [
      '-f', 'lavfi', '-i', `color=c=${ch.color}:size=1280x720:duration=25:rate=24`,
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '25',
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k',
      '-y', partPath,
    ]);
    parts.push(partPath);
  }

  const listPath = path.join(TMP_DIR, 'vis_concat.txt');
  fs.writeFileSync(listPath, parts.map((p) => `file '${p}'`).join('\n'));
  await runCmd('ffmpeg', [
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', outPath,
  ]);
}

async function uploadVideoFile(filepath: string, name: string) {
  const buf = fs.readFileSync(filepath);
  const form = new FormData();
  form.append('video', new Blob([buf], { type: 'video/mp4' }), name);

  const res = await fetch(`${API_BASE}/api/videos/upload`, {
    method: 'POST',
    headers: { Connection: 'close' },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Upload failed for ${name}: ${redactSensitiveText(JSON.stringify(data))}`);
  }
  return data.video;
}

class AnalyzeRequestError extends Error {
  public readonly httpStatus: number | null;
  public readonly data: any;
  public readonly elapsedMs: number;

  constructor(message: string, httpStatus: number | null, data: any, elapsedMs: number) {
    super(redactSensitiveText(message));
    this.httpStatus = httpStatus;
    this.data = data;
    this.elapsedMs = elapsedMs;
  }
}

async function analyzeStrict(payload: Record<string, any>) {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/ai/analyze`, {
      method: 'POST',
      signal: AbortSignal.timeout(295000),
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close',
      },
      body: JSON.stringify({
        preferredProvider: 'strict_nemotron',
        privacyConsent: true,
        targetPlatforms: ['TikTok', 'YouTube Shorts', 'Instagram Reels'],
        ...payload,
      }),
    });
  } catch (networkErr) {
    const errObj = networkErr as Error;
    const causeCode = (errObj as any)?.cause?.code || '';
    const causeMsg = (errObj as any)?.cause?.message || '';
    throw new AnalyzeRequestError(
      `Network/socket error calling /api/ai/analyze: ${errObj.message}${causeCode ? ` (${causeCode}: ${causeMsg})` : ''}`,
      null,
      null,
      Date.now() - t0
    );
  }

  const elapsedMs = Date.now() - t0;
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AnalyzeRequestError(
      `Non-JSON analyze response (HTTP ${res.status}): ${text.slice(0, 300)}`,
      res.status,
      null,
      elapsedMs
    );
  }
  if (!res.ok) {
    throw new AnalyzeRequestError(
      `Analyze HTTP ${res.status} (requestId=${data?.requestId || 'n/a'}): ${data?.error || text.slice(0, 300)}`,
      res.status,
      data,
      elapsedMs
    );
  }
  return {
    data,
    httpStatus: res.status,
    elapsedMs,
    telemetry: extractAiTelemetry(res.status, data, elapsedMs),
  };
}

let liveAnalyzeCallIndex = 0;

async function analyzeStrictPaced(payload: Record<string, any>) {
  if (liveAnalyzeCallIndex > 0) {
    console.log('[Test Pacing] Waiting 20s between live OpenRouter free-tier requests...');
    await new Promise((r) => setTimeout(r, 20000));
  }
  liveAnalyzeCallIndex++;

  try {
    return await analyzeStrict(payload);
  } catch (err) {
    const msg = (err as Error)?.message || '';
    if (msg.includes('HTTP 429') || msg.includes('rate limit')) {
      console.warn('[Test Pacing] OpenRouter free-tier HTTP 429 hit. Waiting 65s for window reset before 1 paced retry...');
      await new Promise((r) => setTimeout(r, 65000));
      return await analyzeStrict(payload);
    }
    throw err;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function runE2E() {
  const reporter = new DiagnosticReporter({
    reportPath: REPORT_PATH,
    preservePreviousReport: true,
    installSignalHandlers: true,
  });
  reporter.initialize();

  console.log('========================================================================');
  console.log('CLIPGENIUS AI — FULL E2E EDITORIAL PIPELINE & FFMPEG VERIFICATION');
  console.log('========================================================================\n');

  const keynotePath = path.join(TMP_DIR, 'e2e_creator_keynote_195s.mp4');
  const shortPath = path.join(TMP_DIR, 'e2e_short_12s.mp4');
  const visualOnlyPath = path.join(TMP_DIR, 'e2e_visual_only_75s.mp4');

  console.log('[Setup] Generating real MP4 test fixtures via FFmpeg...');
  await generateMultiTopicKeynoteVideo(keynotePath);
  await generateShortInsufficientVideo(shortPath);
  await generateVisualOnlyVideo(visualOnlyPath);
  console.log('✓ Test fixtures created cleanly.\n');

  console.log('[Upload] Uploading fixtures through /api/videos/upload...');
  const keynoteVideo = await uploadVideoFile(keynotePath, 'creator_keynote_multi_topic_195s.mp4');
  const shortVideo = await uploadVideoFile(shortPath, 'short_update_12s.mp4');
  const visualOnlyVideo = await uploadVideoFile(visualOnlyPath, 'visual_only_demo_75s.mp4');
  console.log(`✓ Keynote uploaded: ${keynoteVideo.id} (${keynoteVideo.duration}s)`);
  console.log(`✓ Short uploaded:   ${shortVideo.id} (${shortVideo.duration}s)`);
  console.log(`✓ Visual uploaded:  ${visualOnlyVideo.id} (${visualOnlyVideo.duration}s)\n`);

  reporter.setMetadata('videos', {
    keynote: { id: keynoteVideo.id, duration: keynoteVideo.duration },
    short: { id: shortVideo.id, duration: shortVideo.duration },
    visualOnly: { id: visualOnlyVideo.id, duration: visualOnlyVideo.duration },
  });

  let viralShortsClips: any[] = [];
  let hasFatalFailure = false;

  // ------------------------------------------------------------------
  // TEST 1: Insufficient Content Enforcement (12s video vs viral_shorts 30-60s)
  // ------------------------------------------------------------------
  const t1Name = 'test1_insufficient_content';
  reporter.startTest(t1Name, { editorialStyle: 'viral_shorts', videoId: shortVideo.id });
  try {
    const t1 = await analyzeStrictPaced({
      videoId: shortVideo.id,
      clipCount: 4,
      editorialStyle: 'viral_shorts',
      videoCategory: 'Tech & Creators',
    });
    const r1 = t1.data;
    assert(r1.providerUsed === 'nemotron' && r1.modelUsed === 'nvidia/nemotron-3.5-super-vl:free', 'Must use strict nemotron model');
    assert(r1.fallbackUsed === false, 'No Gemini fallback');
    assert(r1.clips.length === 0, 'Must NOT fabricate 30-60s clips from 12s video');
    assert(r1.hasInsufficientContent === true, 'Must flag hasInsufficientContent=true');
    reporter.passTest(t1Name, {
      telemetry: t1.telemetry,
      details: {
        clipsCount: r1.clips.length,
        hasInsufficientContent: r1.hasInsufficientContent,
      },
    });
  } catch (err) {
    hasFatalFailure = true;
    const reqErr = err instanceof AnalyzeRequestError ? err : null;
    reporter.failTest(t1Name, err, {
      telemetry: reqErr ? extractAiTelemetry(reqErr.httpStatus, reqErr.data, reqErr.elapsedMs) : null,
    });
  }

  // ------------------------------------------------------------------
  // TEST 2: Visual-Only Honest Transcript Reporting (No subtitles, silent audio)
  // ------------------------------------------------------------------
  const t2Name = 'test2_visual_only_punchy_hooks';
  reporter.startTest(t2Name, { editorialStyle: 'punchy_hooks', videoId: visualOnlyVideo.id });
  try {
    const t2 = await analyzeStrictPaced({
      videoId: visualOnlyVideo.id,
      clipCount: 2,
      editorialStyle: 'punchy_hooks',
      videoCategory: 'Tech Architecture Demo',
    });
    const r2 = t2.data;
    assert(r2.clips.length >= 1, 'Punchy hooks must return at least 1 valid clip on 75s 3-chapter demo video');
    for (const c of r2.clips) {
      assert(c.duration >= 15 && c.duration <= 30, `Punchy hook duration out of 15-30s range: ${c.duration}s`);
    }
    assert(r2.providerUsed === 'nemotron' && r2.modelUsed === 'nvidia/nemotron-3.5-super-vl:free' && r2.fallbackUsed === false, 'Strict nemotron model verified');
    assert(r2.transcriptVerification?.evidenceMode === 'visual_only', 'Must honestly report visual_only');
    assert(r2.transcriptVerification?.speechAnalysisClaimed === false, 'Must NOT claim speech analysis occurred');
    reporter.passTest(t2Name, {
      telemetry: t2.telemetry,
      details: {
        editorialPolicy: r2.editorialPolicy,
        evidenceMode: r2.transcriptVerification?.evidenceMode,
        speechAnalysisClaimed: r2.transcriptVerification?.speechAnalysisClaimed,
        accepted: r2.clips.map((c: any) => ({
          title: c.title,
          startTime: c.startTime,
          endTime: c.endTime,
          duration: c.duration,
          evidenceMode: c.evidenceMode,
        })),
        rejected: r2.rejectedMoments || [],
        rejectedCount: r2.rejectedMoments?.length || 0,
      },
    });
  } catch (err) {
    hasFatalFailure = true;
    const reqErr = err instanceof AnalyzeRequestError ? err : null;
    reporter.failTest(t2Name, err, {
      telemetry: reqErr ? extractAiTelemetry(reqErr.httpStatus, reqErr.data, reqErr.elapsedMs) : null,
    });
  }

  // ------------------------------------------------------------------
  // TEST 3: Viral Shorts (30-60s) on 195s Multi-Topic Video w/ Embedded Subtitles (4 candidates)
  // ------------------------------------------------------------------
  const t3Name = 'test3_viral_shorts_combined';
  reporter.startTest(t3Name, { editorialStyle: 'viral_shorts', videoId: keynoteVideo.id });
  try {
    const t3 = await analyzeStrictPaced({
      videoId: keynoteVideo.id,
      clipCount: 4,
      editorialStyle: 'viral_shorts',
      videoCategory: 'Tech, AI & Creator Economy',
      creatorDirection: 'Extract 4 distinct self-contained chapters avoiding any color bars or blank ending frames.',
    });
    const r3 = t3.data;
    for (const c of r3.clips) {
      assert(c.duration >= 30 && c.duration <= 60, `Viral Shorts duration out of 30-60s range: ${c.duration}s`);
      assert(c.endTime <= 186.5, `Clip overlapped SMPTE/black technical segment (${c.endTime}s)`);
    }
    assert(r3.providerUsed === 'nemotron' && r3.modelUsed === 'nvidia/nemotron-3.5-super-vl:free', 'Strict Nemotron verified');
    assert(r3.fallbackUsed === false, 'Gemini NOT called');
    assert(r3.transcriptVerification?.evidenceMode === 'combined', 'Must detect embedded subtitles -> combined');
    assert(r3.transcriptVerification?.speechAnalysisClaimed === true, 'Speech verified');
    assert(r3.clips.length >= 2, `Expected multiple distinct 30-60s candidates, got ${r3.clips.length}`);

    viralShortsClips = r3.clips;
    reporter.passTest(t3Name, {
      telemetry: t3.telemetry,
      details: {
        editorialPolicy: r3.editorialPolicy,
        transcriptVerification: {
          evidenceMode: r3.transcriptVerification?.evidenceMode,
          transcriptSource: r3.transcriptVerification?.transcriptSource,
          speechAnalysisClaimed: r3.transcriptVerification?.speechAnalysisClaimed,
          segmentsCount: r3.transcriptVerification?.segmentsCount,
        },
        accepted: r3.clips.map((c: any) => ({
          id: c.id,
          title: c.title,
          startTime: c.startTime,
          endTime: c.endTime,
          boundaryAdjusted: Boolean(c.boundaryAdjusted),
          duration: c.duration,
          viralityScore: c.viralityScore,
          evidenceMode: c.evidenceMode,
        })),
        rejected: r3.rejectedMoments,
      },
    });
  } catch (err) {
    hasFatalFailure = true;
    const reqErr = err instanceof AnalyzeRequestError ? err : null;
    reporter.failTest(t3Name, err, {
      telemetry: reqErr ? extractAiTelemetry(reqErr.httpStatus, reqErr.data, reqErr.elapsedMs) : null,
    });
  }

  // ------------------------------------------------------------------
  // TEST 4A: Educational Style (20-60s)
  // ------------------------------------------------------------------
  const t4EduName = 'test4a_educational_style';
  reporter.startTest(t4EduName, { editorialStyle: 'educational', videoId: keynoteVideo.id });
  try {
    const t4Edu = await analyzeStrictPaced({
      videoId: keynoteVideo.id,
      clipCount: 3,
      editorialStyle: 'educational',
      videoCategory: 'Educational & Science',
    });
    const r4Edu = t4Edu.data;
    assert(r4Edu.clips.length >= 1, 'Educational style must return at least 1 valid clip on coherent 195s video');
    for (const c of r4Edu.clips) {
      assert(c.duration >= 20 && c.duration <= 60, `Educational duration out of 20-60s: ${c.duration}s`);
    }
    assert(r4Edu.providerUsed === 'nemotron' && r4Edu.modelUsed === 'nvidia/nemotron-3.5-super-vl:free' && r4Edu.fallbackUsed === false, 'Strict nemotron educational model verified');
    reporter.passTest(t4EduName, {
      telemetry: t4Edu.telemetry,
      details: {
        editorialPolicy: r4Edu.editorialPolicy,
        accepted: r4Edu.clips.map((c: any) => ({
          title: c.title,
          startTime: c.startTime,
          endTime: c.endTime,
          duration: c.duration,
        })),
        rejected: r4Edu.rejectedMoments,
      },
    });
  } catch (err) {
    hasFatalFailure = true;
    const reqErr = err instanceof AnalyzeRequestError ? err : null;
    reporter.failTest(t4EduName, err, {
      telemetry: reqErr ? extractAiTelemetry(reqErr.httpStatus, reqErr.data, reqErr.elapsedMs) : null,
    });
  }

  // ------------------------------------------------------------------
  // TEST 4B: Storytelling Style (25-60s)
  // ------------------------------------------------------------------
  const t4StoryName = 'test4b_storytelling_style';
  reporter.startTest(t4StoryName, { editorialStyle: 'storytelling', videoId: keynoteVideo.id });
  try {
    const t4Story = await analyzeStrictPaced({
      videoId: keynoteVideo.id,
      clipCount: 3,
      editorialStyle: 'storytelling',
      videoCategory: 'Creator Storytelling',
    });
    const r4Story = t4Story.data;
    assert(r4Story.clips.length >= 1, 'Storytelling must return at least 1 valid clip on coherent 195s video');
    for (const c of r4Story.clips) {
      assert(c.duration >= 25 && c.duration <= 60, `Storytelling duration out of 25-60s: ${c.duration}s`);
    }
    assert(r4Story.providerUsed === 'nemotron' && r4Story.modelUsed === 'nvidia/nemotron-3.5-super-vl:free' && r4Story.fallbackUsed === false, 'Strict nemotron storytelling model verified');
    reporter.passTest(t4StoryName, {
      telemetry: t4Story.telemetry,
      details: {
        editorialPolicy: r4Story.editorialPolicy,
        accepted: r4Story.clips.map((c: any) => ({
          title: c.title,
          startTime: c.startTime,
          endTime: c.endTime,
          duration: c.duration,
        })),
        rejected: r4Story.rejectedMoments,
      },
    });
  } catch (err) {
    hasFatalFailure = true;
    const reqErr = err instanceof AnalyzeRequestError ? err : null;
    reporter.failTest(t4StoryName, err, {
      telemetry: reqErr ? extractAiTelemetry(reqErr.httpStatus, reqErr.data, reqErr.elapsedMs) : null,
    });
  }

  // ------------------------------------------------------------------
  // TEST 4C: Creator Direction End-to-End Steering Verification
  // ------------------------------------------------------------------
  const t4DirName = 'test4c_creator_direction';
  const targetedDirection =
    'Focus ONLY on Topic 3 about HTTP 206 byte-range streaming and instant timeline scrubbing (around 77s-114s). Return 1 clip specifically covering HTTP 206 streaming.';
  reporter.startTest(t4DirName, {
    editorialStyle: 'educational',
    videoId: keynoteVideo.id,
    creatorDirection: targetedDirection,
  });
  try {
    const t4Dir = await analyzeStrictPaced({
      videoId: keynoteVideo.id,
      clipCount: 1,
      editorialStyle: 'educational',
      videoCategory: 'Video Infrastructure',
      creatorDirection: targetedDirection,
    });
    const r4Dir = t4Dir.data;
    assert(r4Dir.providerUsed === 'nemotron' && r4Dir.modelUsed === 'nvidia/nemotron-3.5-super-vl:free' && r4Dir.fallbackUsed === false, 'Strict nemotron creator direction model verified');
    assert(r4Dir.creatorDirectionUsed === targetedDirection, 'Server must echo exact creatorDirectionUsed');
    assert(r4Dir.clips.length >= 1, 'Creator direction test must return at least 1 clip');
    const c0 = r4Dir.clips[0];
    assert(c0.duration >= 20 && c0.duration <= 60, `Creator direction clip duration out of 20-60s: ${c0.duration}s`);
    const clipText = `${c0.title} ${c0.hook} ${c0.description} ${c0.transcriptSegment || ''}`.toLowerCase();
    const overlapsTopic3 = c0.endTime >= 76 && c0.startTime <= 116;
    const mentionsTopic3 =
      clipText.includes('206') || clipText.includes('stream') || clipText.includes('scrub') || clipText.includes('buffer');
    assert(
      overlapsTopic3 && mentionsTopic3,
      `Creator direction did not steer selection to Topic 3 (got [${c0.startTime}s-${c0.endTime}s] "${c0.title}")`
    );

    reporter.passTest(t4DirName, {
      telemetry: t4Dir.telemetry,
      details: {
        creatorDirectionUsed: r4Dir.creatorDirectionUsed,
        accepted: r4Dir.clips.map((c: any) => ({
          title: c.title,
          startTime: c.startTime,
          endTime: c.endTime,
          duration: c.duration,
        })),
        rejected: r4Dir.rejectedMoments,
      },
    });
  } catch (err) {
    hasFatalFailure = true;
    const reqErr = err instanceof AnalyzeRequestError ? err : null;
    reporter.failTest(t4DirName, err, {
      telemetry: reqErr ? extractAiTelemetry(reqErr.httpStatus, reqErr.data, reqErr.elapsedMs) : null,
    });
  }

  // ------------------------------------------------------------------
  // TEST 5: Individual Clip Previews + Batch FFmpeg Render Jobs + Playable MP4 Verification
  // ------------------------------------------------------------------
  const skipRender = process.argv.includes('--skip-render') || process.argv.includes('--checkpoint=3');
  const t5Name = 'test5_previews_and_batch_render';
  if (skipRender) {
    reporter.markSkipped(t5Name, 'Held for Checkpoint 4 (--checkpoint=3 / --skip-render)');
  } else if (viralShortsClips.length === 0) {
    reporter.markSkipped(t5Name, 'Skipped because TEST 3 did not produce accepted clips');
  } else {
    const selectedClips = viralShortsClips.slice(0, 4);
    reporter.startTest(t5Name, { clipCount: selectedClips.length });
    try {
      const previewResults: any[] = [];
      for (const c of selectedClips) {
        const thumbRes = await fetch(`${API_BASE}/api/thumbnails/clip/${keynoteVideo.id}?t=${Math.round(c.startTime)}`);
        const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
        assert(thumbRes.status === 200 && thumbBuf.length > 1000, `Thumbnail failed for ${c.id}`);

        const streamRes = await fetch(`${API_BASE}/api/videos/stream/${keynoteVideo.id}`, {
          headers: { Range: 'bytes=0-65535' },
        });
        assert(streamRes.status === 206, `Stream 206 range check failed for ${c.id}`);
        previewResults.push({
          clipId: c.id,
          thumbnailStatus: thumbRes.status,
          thumbnailBytes: thumbBuf.length,
          streamStatus: streamRes.status,
          contentRange: streamRes.headers.get('content-range'),
        });
      }

      const batchRes = await fetch(`${API_BASE}/api/clips/batch-render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({
          clips: selectedClips.map((c: any) => ({
            clipId: c.id,
            sourceVideoId: keynoteVideo.id,
            title: c.title,
            startTime: c.startTime,
            endTime: c.endTime,
            aspectRatio: '9:16',
          })),
          defaultAspectRatio: '9:16',
        }),
      });
      const batchData = await batchRes.json();
      assert(batchRes.ok && Array.isArray(batchData.jobs) && batchData.jobs.length === selectedClips.length, 'Batch render dispatch failed');

      const completedJobs: any[] = [];
      for (const job of batchData.jobs) {
        let current = job;
        for (let attempt = 0; attempt < 90; attempt++) {
          const stRes = await fetch(`${API_BASE}/api/clips/status/${job.id}`);
          const stData = await stRes.json();
          current = stData.job;
          if (current.status === 'completed' || current.status === 'failed') break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        assert(current.status === 'completed', `Render job ${job.id} did not complete: ${current.status} (${current.error})`);

        const dlRes = await fetch(`${API_BASE}/api/clips/download/${job.id}`);
        assert(dlRes.status === 200, `Download failed for ${job.id}`);
        const mp4Buf = Buffer.from(await dlRes.arrayBuffer());
        assert(mp4Buf.length > 5000, `Rendered MP4 too small (${mp4Buf.length} bytes)`);

        const dlPath = path.join(TMP_DIR, `downloaded_${job.id}.mp4`);
        fs.writeFileSync(dlPath, mp4Buf);
        const { stdout: probeOut } = await runCmd('ffprobe', [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format', '-show_streams',
          dlPath,
        ]);
        const probeJson = JSON.parse(probeOut);
        const videoStream = probeJson.streams?.find((s: any) => s.codec_type === 'video');
        const actualDur = parseFloat(probeJson.format?.duration || '0');
        completedJobs.push({
          jobId: job.id,
          clipId: current.clipId,
          title: current.title,
          status: current.status,
          bytes: mp4Buf.length,
          resolution: `${videoStream?.width}x${videoStream?.height}`,
          ffprobeDuration: Math.round(actualDur * 100) / 100,
          expectedDuration: Math.round((current.endTime - current.startTime) * 100) / 100,
        });
      }

      reporter.passTest(t5Name, {
        details: {
          previewResults,
          completedJobs,
        },
      });
    } catch (err) {
      hasFatalFailure = true;
      reporter.failTest(t5Name, err);
    }
  }

  const finalDoc = reporter.finalize(hasFatalFailure ? 'failed' : 'completed');
  console.log(`\n✓ Saved incremental E2E verification report to ${REPORT_PATH}`);
  console.log(`Summary: passed=${finalDoc.summary.passed}, failed=${finalDoc.summary.failed}, incomplete=${finalDoc.summary.incomplete}, skipped=${finalDoc.summary.skipped}`);
  if (hasFatalFailure) {
    process.exit(1);
  }
  console.log('========================================================================');
  console.log('ALL END-TO-END VERIFICATION CHECKS PASSED SUCCESSFULLY!');
  console.log('========================================================================');
}

runE2E().catch((err) => {
  console.error('\n❌ E2E VERIFICATION FAILED:', redactSensitiveText((err as Error).message || String(err)));
  process.exit(1);
});
