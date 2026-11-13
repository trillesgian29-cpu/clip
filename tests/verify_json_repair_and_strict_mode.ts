import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
dotenv.config();

import {
  extractAndSanitizeJson,
  validateAndNormalizeCandidate,
  repairNemotronJsonWithOpenRouter,
  NEMOTRON_MODEL,
} from '../server/nemotron.ts';
import { dispatchVideoAnalysis } from '../server/aiDispatcher.ts';
import { DiagnosticReporter, extractAiTelemetry } from './lib/diagnosticReporter.ts';

const execFileAsync = promisify(execFile);
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const REPORT_PATH = path.resolve('json_repair_strict_report.json');

async function ensureCoherentMultiTopicFixture(outPath: string): Promise<void> {
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 100000) {
    return;
  }
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempWorkDir = path.join(dir, 'json_strict_fixture_tmp');
  fs.mkdirSync(tempWorkDir, { recursive: true });

  try {
    const chapters = [
      {
        idx: 1,
        color: '#111827',
        dur: 38,
        title: 'CHAPTER 1: DISTRIBUTION BEATS BENCHMARKS',
        line1: 'Hook: Founders obsess over accuracy while ignoring distribution.',
        line2: 'Insight: Distribution channels beat raw benchmarks every time.',
        line3: 'Payoff: Own the daily user workflow first.',
      },
      {
        idx: 2,
        color: '#1e1b4b',
        dur: 38,
        title: 'CHAPTER 2: THE 3-SECOND HOOK RULE',
        line1: 'Hook: 65 percent of viewers leave before second three.',
        line2: 'Insight: Open with a visual contradiction or bold claim.',
        line3: 'Payoff: Deliver the full answer cleanly within 40 seconds.',
      },
      {
        idx: 3,
        color: '#064e3b',
        dur: 38,
        title: 'CHAPTER 3: HTTP 206 INSTANT SEEK STREAMING',
        line1: 'Hook: Full downloads kill viewer retention on mobile.',
        line2: 'Insight: Byte-range 206 streaming serves keyframes instantaneously.',
        line3: 'Payoff: Timeline scrubbing cuts bounce rate in half.',
      },
    ];

    const segFiles: string[] = [];
    for (const ch of chapters) {
      const segPath = path.join(tempWorkDir, `seg_${ch.idx}.mp4`);
      const vf = [
        `drawtext=fontfile=${FONT_BOLD}:text='${ch.title}':x=70:y=110:fontsize=34:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=10`,
        `drawtext=fontfile=${FONT_REG}:text='${ch.line1}':x=70:y=220:fontsize=26:fontcolor=#fde047:box=1:boxcolor=black@0.55:boxborderw=8`,
        `drawtext=fontfile=${FONT_REG}:text='${ch.line2}':x=70:y=310:fontsize=26:fontcolor=#67e8f9:box=1:boxcolor=black@0.55:boxborderw=8`,
        `drawtext=fontfile=${FONT_REG}:text='${ch.line3}':x=70:y=400:fontsize=26:fontcolor=#86efac:box=1:boxcolor=black@0.55:boxborderw=8`,
        `drawtext=fontfile=${FONT_REG}:text='Chapter ${ch.idx}  Time %{pts\\:hms}':x=70:y=540:fontsize=24:fontcolor=white`,
      ].join(',');

      await execFileAsync('ffmpeg', [
        '-f', 'lavfi', '-i', `color=c=${ch.color}:size=1280x720:duration=${ch.dur}:rate=24`,
        '-f', 'lavfi', '-i', `aevalsrc=sin(${210 + ch.idx * 60}*2*PI*t)*0.18:d=${ch.dur}`,
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k',
        '-y', segPath,
      ]);
      segFiles.push(segPath);
    }

    const concatList = path.join(tempWorkDir, 'concat.txt');
    fs.writeFileSync(concatList, segFiles.map((f) => `file '${f}'`).join('\n'));
    const mergedPath = path.join(tempWorkDir, 'merged.mp4');
    await execFileAsync('ffmpeg', [
      '-f', 'concat', '-safe', '0', '-i', concatList,
      '-c', 'copy',
      '-y', mergedPath,
    ]);

    const srtPath = path.join(tempWorkDir, 'coherent.srt');
    fs.writeFileSync(
      srtPath,
      `1
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
Deliver the promised payoff cleanly inside forty seconds.

7
00:01:17,000 --> 00:01:29,000
Waiting for a full MP4 download kills viewer retention on mobile networks.

8
00:01:29,500 --> 00:01:41,000
HTTP 206 byte-range streaming serves exact keyframes instantaneously when seeking.

9
00:01:41,500 --> 00:01:52,500
Instant timeline scrubbing slashes server bandwidth and drops bounce rate in half.
`,
      'utf8'
    );

    await execFileAsync('ffmpeg', [
      '-i', mergedPath,
      '-i', srtPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-c:s', 'mov_text',
      '-movflags', '+faststart',
      '-y', outPath,
    ]);
  } finally {
    fs.rmSync(tempWorkDir, { recursive: true, force: true });
  }
}

async function runTestSuite() {
  const reporter = new DiagnosticReporter({
    reportPath: REPORT_PATH,
    preservePreviousReport: true,
    installSignalHandlers: true,
  });
  reporter.initialize();

  console.log('====================================================');
  console.log('CLIPGENIUS AI: NEMOTRON JSON REPAIR & STRICT MODE TEST');
  console.log('====================================================\n');

  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;
  let totalTests = 0;

  function recordTest(
    name: string,
    condition: boolean,
    detail: string = '',
    extra?: { telemetry?: any; details?: Record<string, unknown> }
  ) {
    totalTests++;
    const testKey = `test_${String(totalTests).padStart(2, '0')}_${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 48)}`;
    reporter.startTest(testKey, { label: name });
    if (condition) {
      console.log(`[PASS] Test ${totalTests}: ${name} ${detail ? `(${detail})` : ''}`);
      passedTests++;
      reporter.passTest(testKey, {
        telemetry: extra?.telemetry || null,
        details: { label: name, detail, ...(extra?.details || {}) },
      });
    } else {
      failedTests++;
      const msg = detail ? `${name} (${detail})` : name;
      console.error(`[FAIL] Test ${totalTests}: ${msg}`);
      reporter.failTest(testKey, new Error(msg), {
        telemetry: extra?.telemetry || null,
        details: { label: name, detail, ...(extra?.details || {}) },
      });
    }
  }

  function recordSkip(name: string, reason: string) {
    totalTests++;
    skippedTests++;
    const testKey = `test_${String(totalTests).padStart(2, '0')}_${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .slice(0, 48)}`;
    reporter.markSkipped(testKey, reason);
  }

  // ----------------------------------------------------
  // TEST GROUP 1: Valid, Fenced, Trailing-Comma & Truncated JSON Handling
  // ----------------------------------------------------
  console.log('--- Test Group 1: JSON Sanitization, Valid, Fenced & Truncated Handling ---');
  const validJson = '{"hasInsufficientContent": false, "analysisSummary": "Valid structured payload", "clips": []}';
  const sanitizedValid = extractAndSanitizeJson(validJson);
  const parsedValid = JSON.parse(sanitizedValid);
  recordTest('Valid raw JSON parses cleanly', parsedValid.hasInsufficientContent === false && Array.isArray(parsedValid.clips));

  const markdownWrapped = '```json\n{"hasInsufficientContent": false, "analysisSummary": "Good video", "clips": []}\n```';
  const sanitized1 = extractAndSanitizeJson(markdownWrapped);
  recordTest('Extracts clean JSON from ```json code fence', sanitized1.startsWith('{') && sanitized1.endsWith('}'));
  const parsed1 = JSON.parse(sanitized1);
  recordTest('Cleaned fenced JSON parses successfully with JSON.parse', parsed1.hasInsufficientContent === false);

  const trailingCommaJson = '{"clips": [{"title": "Clip 1", "startTime": 10, "endTime": 25,},],}';
  const sanitized2 = extractAndSanitizeJson(trailingCommaJson);
  let parsedTrailing = false;
  try {
    JSON.parse(sanitized2);
    parsedTrailing = true;
  } catch {
    parsedTrailing = false;
  }
  recordTest('Sanitizer cleans trailing commas before closing braces/brackets', parsedTrailing);

  const truncatedJson = '{"hasInsufficientContent": false, "analysisSummary": "Cut off mid-stream", "clips": [{"title": "Partial';
  const sanitizedTruncated = extractAndSanitizeJson(truncatedJson);
  let truncatedRejected = false;
  try {
    JSON.parse(sanitizedTruncated);
  } catch {
    truncatedRejected = true;
  }
  recordTest('Truncated JSON output is rejected rather than partially fabricated', truncatedRejected);

  // ----------------------------------------------------
  // TEST GROUP 2: Candidate Normalization & Multi-dimensional scoring
  // ----------------------------------------------------
  console.log('\n--- Test Group 2: Schema Validation & Normalization ---');
  const mockCandidate = {
    title: '  The Hidden Pattern of Retention  ',
    hook: 'Why 99% of creators fail in the first 3 seconds',
    startTime: '5.2',
    endTime: '35.8',
    reason: 'Surprising insight into pacing and dropoff',
    confidence: 0.95,
    category: 'Educational',
    weakness: 'Audio slightly quiet at beginning',
    alternate_hooks: ['The one mistake ruining your videos', 'Stop doing this in short form'],
    exact_quote: 'You lose 80% of viewers before word five.',
    scores: {
      hookStrength: 0.92,
      audienceCuriosity: 0.88,
      informationalValue: 0.95,
      storyFlow: 0.85,
      standaloneContext: 0.9,
      payoff: 0.89,
      shareability: 0.91,
    },
  };

  const normalized = validateAndNormalizeCandidate(mockCandidate, 100, 0, 100);
  recordTest('Candidate normalized successfully', normalized !== null);
  recordTest('Timestamps converted to numeric', typeof normalized?.startTime === 'number' && normalized?.startTime === 5.2);
  recordTest('Scores correctly scaled from 0-1 to 0-10 scale', normalized?.scores.hookStrength === 9.2);
  recordTest('Alternate hooks preserved', normalized?.alternate_hooks?.length === 2);

  // ----------------------------------------------------
  // TEST GROUP 3: 1-Shot JSON Repair with OpenRouter
  // ----------------------------------------------------
  console.log('\n--- Test Group 3: 1-Shot JSON Repair via OpenRouter ---');
  const apiKey = process.env.OPENROUTER_API_KEY!;
  if (!apiKey || apiKey === 'MY_OPENROUTER_API_KEY') {
    recordSkip('1-Shot JSON Repair via OpenRouter', 'OPENROUTER_API_KEY missing from environment');
  } else {
    const malformedJson = `{
      "hasInsufficientContent": false,
      "analysisSummary": "The host asked: "What is the secret?", and the guest replied.",
      "clips": [
        {
          "title": "The Big Reveal",
          "hook": "Guest said: "Watch this", then explained.",
          "startTime": 5.0,
          "endTime": 25.0,
          "reason": "Host said "Why?" and guest gave the complete answer.",
          "confidence": 0.9,
          "category": "Tech",
          "weakness": "Needs captions",
          "scores": {
            "hookStrength": 8.5,
            "audienceCuriosity": 8.0,
            "informationalValue": 9.0,
            "storyFlow": 8.5,
            "standaloneContext": 9.0,
            "payoff": 8.5,
            "shareability": 8.5
          }
        }
      ]
    }`;

    let nativeParseFailed = false;
    try {
      JSON.parse(malformedJson);
    } catch {
      nativeParseFailed = true;
    }
    recordTest('Confirmed malformed JSON with unescaped quotes fails native JSON.parse', nativeParseFailed);

    console.log('[Test] Calling repairNemotronJsonWithOpenRouter on malformed input...');
    let repairRes: { repairedJson: any; latencyMs: number } | null = null;
    let repairErrMsg = '';
    try {
      repairRes = await repairNemotronJsonWithOpenRouter(
        malformedJson,
        'Unexpected token in JSON at position 60',
        apiKey
      );
    } catch (err) {
      repairErrMsg = (err as Error).message;
    }

    const repairDetails = {
      repairAttempted: true,
      repairLatencyMs: repairRes?.latencyMs ?? null,
      repairError: repairErrMsg || null,
      model: NEMOTRON_MODEL,
    };

    recordTest('Repair call returned repairedJson object', Boolean(repairRes && typeof repairRes.repairedJson === 'object'), repairErrMsg, {
      details: repairDetails,
    });
    recordTest('Repaired JSON contains clips array', Boolean(repairRes && Array.isArray(repairRes.repairedJson?.clips)), repairErrMsg, {
      details: repairDetails,
    });
    recordTest('Repaired JSON clips count > 0', Boolean(repairRes && repairRes.repairedJson?.clips?.length > 0), repairErrMsg, {
      details: repairDetails,
    });
    recordTest('Repaired JSON preserved timestamps', Boolean(repairRes && repairRes.repairedJson?.clips?.[0]?.startTime === 5.0), repairErrMsg, {
      details: repairDetails,
    });
  }

  // ----------------------------------------------------
  // TEST GROUP 4A (Negative): Static / Insufficient Fixture Rejection
  // ----------------------------------------------------
  console.log('\n--- Test Group 4A (Negative): Static Single-Slide Fixture Correctly Rejected ---');
  const staticSamplePath = path.resolve('samples/sample-podcast-1794235524195.mp4');
  if (fs.existsSync(staticSamplePath)) {
    const t0Neg = Date.now();
    try {
      const negRes = await dispatchVideoAnalysis({
        preferredProvider: 'strict_nemotron',
        sourceVideoId: 'sample-podcast-static',
        sourcePath: staticSamplePath,
        filename: 'Tech Leaders Podcast #42.mp4',
        duration: 65,
        clipCount: 2,
        clipStyle: 'viral_shorts',
        editorialStyle: 'viral_shorts',
        videoCategory: 'Podcast & Interview',
        targetPlatforms: ['TikTok', 'YouTube Shorts', 'Instagram Reels'],
        chunkName: 'part_01',
        chunkOffsetSeconds: 0,
      });
      const negTelemetry = extractAiTelemetry(200, negRes, Date.now() - t0Neg);
      recordTest(
        'Static/no-progression sample correctly rejected under viral_shorts (0 clips, hasInsufficientContent=true, no Gemini fallback)',
        negRes.providerUsed === 'nemotron' &&
          negRes.fallbackUsed === false &&
          negRes.clips.length === 0 &&
          negRes.hasInsufficientContent === true,
        `provider=${negRes.providerUsed}, model=${negRes.modelUsed}, clips=${negRes.clips.length}, insufficient=${negRes.hasInsufficientContent}, fallback=${negRes.fallbackUsed}`,
        {
          telemetry: negTelemetry,
          details: {
            fixturePath: staticSamplePath,
            clipsCount: negRes.clips.length,
            hasInsufficientContent: negRes.hasInsufficientContent,
            analysisSummary: negRes.analysisSummary,
          },
        }
      );
    } catch (err) {
      recordTest(
        'Static/no-progression sample correctly rejected under viral_shorts (0 clips, hasInsufficientContent=true, no Gemini fallback)',
        false,
        (err as Error).message
      );
    }
  } else {
    recordSkip('Static single-slide negative test', `Sample not found at ${staticSamplePath}`);
  }

  // ----------------------------------------------------
  // TEST GROUP 4B (Positive): Coherent Multi-Topic Video under Strict Nemotron (Fixes Tests 16 & 19)
  // ----------------------------------------------------
  console.log('\n--- Test Group 4B (Positive): Coherent Multi-Topic Strict Nemotron Analysis ---');
  const coherentPath = path.resolve('uploads/tmp_e2e/coherent_keynote_strict_114s.mp4');
  await ensureCoherentMultiTopicFixture(coherentPath);

  const t0Pos = Date.now();
  let dispatchRes: Awaited<ReturnType<typeof dispatchVideoAnalysis>> | null = null;
  let posErrMsg = '';
  try {
    dispatchRes = await dispatchVideoAnalysis({
      preferredProvider: 'strict_nemotron',
      sourceVideoId: 'coherent-strict-fixture',
      sourcePath: coherentPath,
      filename: 'coherent_keynote_strict_114s.mp4',
      duration: 114,
      clipCount: 2,
      clipStyle: 'viral_shorts',
      editorialStyle: 'viral_shorts',
      videoCategory: 'Tech & Creators',
      targetPlatforms: ['TikTok', 'YouTube Shorts', 'Instagram Reels'],
      chunkName: 'part_01',
      chunkOffsetSeconds: 0,
    });
  } catch (err) {
    posErrMsg = (err as Error).message;
  }

  const posTelemetry = dispatchRes ? extractAiTelemetry(200, dispatchRes, Date.now() - t0Pos) : null;
  const posClipsSummary = (dispatchRes?.clips || []).map((c) => ({
    title: c.title,
    startTime: c.startTime,
    endTime: c.endTime,
    duration: c.duration,
  }));

  recordTest(
    'Provider used was nemotron',
    Boolean(dispatchRes && dispatchRes.providerUsed === 'nemotron'),
    posErrMsg || `provider=${dispatchRes?.providerUsed}`,
    { telemetry: posTelemetry }
  );
  recordTest(
    'Model used was nvidia/nemotron-3.5-super-vl:free',
    Boolean(dispatchRes && dispatchRes.modelUsed === NEMOTRON_MODEL),
    posErrMsg || `model=${dispatchRes?.modelUsed}`,
    { telemetry: posTelemetry }
  );
  recordTest(
    'Fallback was NOT used in strict mode',
    Boolean(dispatchRes && dispatchRes.fallbackUsed === false),
    posErrMsg || `fallbackUsed=${dispatchRes?.fallbackUsed}`,
    { telemetry: posTelemetry }
  );
  recordTest(
    'Clips extracted > 0 from coherent multi-topic video',
    Boolean(dispatchRes && dispatchRes.clips.length > 0),
    posErrMsg || `clips=${dispatchRes?.clips.length ?? 0}`,
    { telemetry: posTelemetry, details: { clips: posClipsSummary, rejected: dispatchRes?.rejectedMoments } }
  );
  recordTest(
    'Cost is $0.00 (free model)',
    Boolean(dispatchRes && (dispatchRes.openRouterDetails?.cost ?? 0) === 0),
    posErrMsg || `cost=${dispatchRes?.openRouterDetails?.cost}`,
    { telemetry: posTelemetry }
  );
  recordTest(
    'JSON parsing status is valid or repaired',
    Boolean(
      dispatchRes &&
        (dispatchRes.openRouterDetails?.jsonParsingStatus === 'json_parsed_successfully' ||
          dispatchRes.openRouterDetails?.jsonParsingStatus === 'repaired_successfully')
    ),
    posErrMsg || `jsonParsingStatus=${dispatchRes?.openRouterDetails?.jsonParsingStatus}, repairRetryCount=${dispatchRes?.openRouterDetails?.repairRetryCount}`,
    { telemetry: posTelemetry }
  );
  const s0 = dispatchRes?.clips[0]?.scores;
  recordTest(
    'Generated clips have complete 7-dimension scores',
    Boolean(
      s0 &&
        typeof s0.hook === 'number' &&
        typeof s0.standalone === 'number' &&
        typeof s0.emotion === 'number' &&
        typeof s0.payoff === 'number' &&
        typeof s0.share_worthy === 'number' &&
        typeof s0.pacing === 'number' &&
        typeof s0.visual_potential === 'number'
    ),
    posErrMsg || `scores=${s0 ? JSON.stringify(s0) : 'none'}`,
    { telemetry: posTelemetry }
  );
  recordTest(
    'Extracted clips respect Viral Shorts 30-60s duration policy',
    Boolean(dispatchRes && dispatchRes.clips.length > 0 && dispatchRes.clips.every((c) => c.duration >= 29.5 && c.duration <= 61)),
    posErrMsg || `durations=${posClipsSummary.map((c) => `${c.duration}s`).join(', ')}`,
    { telemetry: posTelemetry }
  );

  // ----------------------------------------------------
  // TEST GROUP 5: Strict Mode Isolation vs. Auto Fallback Behavior
  // ----------------------------------------------------
  console.log('\n--- Test Group 5: Strict Mode Failure Policy & Auto Fallback Verification ---');
  let strictErrMsg = '';
  let strictThrewProperly = false;
  try {
    await dispatchVideoAnalysis({
      preferredProvider: 'strict_nemotron',
      sourceVideoId: 'non-existent',
      sourcePath: '/tmp/non-existent-video.mp4',
      filename: 'non-existent.mp4',
      duration: 60,
    });
  } catch (err) {
    strictErrMsg = (err as Error).message;
    strictThrewProperly = strictErrMsg.includes('Strict Nemotron Mode failed');
  }
  recordTest(
    'Strict mode throws error instead of calling Gemini',
    strictThrewProperly,
    strictErrMsg || 'Did not throw Strict Nemotron Mode failed',
    { details: { error: strictErrMsg } }
  );

  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY') {
    const t0Auto = Date.now();
    try {
      const autoRes = await dispatchVideoAnalysis({
        preferredProvider: 'auto_fallback',
        sourceVideoId: 'auto-fallback-test',
        sourcePath: '/tmp/non-existent-video-auto-fallback.mp4',
        filename: 'auto_fallback_test.mp4',
        duration: 60,
        clipCount: 1,
        clipStyle: 'educational',
        editorialStyle: 'educational',
        transcript:
          '[00:00] Hook: Distribution beats raw accuracy.\n[00:15] Insight: Own the workflow.\n[00:35] Payoff: Faster iteration wins.',
      });
      const autoTelemetry = extractAiTelemetry(200, autoRes, Date.now() - t0Auto);
      recordTest(
        'Auto fallback mode transparently falls back to Gemini when Nemotron cannot run',
        autoRes.fallbackUsed === true &&
          autoRes.providerUsed === 'gemini' &&
          Boolean(autoRes.fallbackReason) &&
          autoRes.clips.length > 0,
        `provider=${autoRes.providerUsed}, model=${autoRes.modelUsed}, fallbackUsed=${autoRes.fallbackUsed}, clips=${autoRes.clips.length}`,
        {
          telemetry: autoTelemetry,
          details: {
            fallbackReason: autoRes.fallbackReason,
            clips: autoRes.clips.map((c) => ({
              title: c.title,
              startTime: c.startTime,
              endTime: c.endTime,
              duration: c.duration,
            })),
          },
        }
      );
    } catch (err) {
      recordTest(
        'Auto fallback mode transparently falls back to Gemini when Nemotron cannot run',
        false,
        (err as Error).message
      );
    }
  } else {
    recordSkip('Auto fallback Gemini verification', 'GEMINI_API_KEY not configured');
  }

  reporter.setMetadata('counts', {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    skipped: skippedTests,
  });
  const finalDoc = reporter.finalize(failedTests > 0 ? 'failed' : 'completed');

  console.log('\n====================================================');
  console.log(`TEST RESULTS: ${passedTests}/${totalTests} TESTS PASSED! (${failedTests} failed, ${skippedTests} skipped)`);
  console.log(`Diagnostic report saved to: ${REPORT_PATH}`);
  console.log('====================================================\n');

  if (failedTests > 0 || finalDoc.summary.failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
