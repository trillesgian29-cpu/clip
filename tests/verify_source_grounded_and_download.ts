import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { DiagnosticReporter } from './lib/diagnosticReporter.ts';
import { probeVideo, verifyDecodableRange, renderClip } from '../server/ffmpeg.ts';
import {
  precomputeVideoQualityContext,
  inspectIntervalVisualProgression,
  validateSegmentQuality,
} from '../server/contentQualityInspector.ts';
import {
  probeIntervalAudioActivity,
  verifyExactQuoteMatchesInterval,
  alignClipWithTranscriptSegments,
  parseTimestampedTranscript,
} from '../server/transcriptVerifier.ts';
import {
  buildAdaptiveFrameTimestamps,
  evaluateCandidateVerification,
  validateAndNormalizeCandidate,
} from '../server/nemotron.ts';

dotenv.config();

const execFileAsync = promisify(execFile);
const TEST_PORT = 3106;
const TEST_API_BASE = `http://localhost:${TEST_PORT}`;
const TEST_PASSCODE = 'src-grounded-dl-verify-2026';
const TEST_SESSION_SECRET = 'src-grounded-dl-session-2026';
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const TMP_DIR = path.resolve('uploads/tmp_src_dl');
const DL_DIR = path.join(TMP_DIR, 'local_downloads');
const REPORT_PATH = path.resolve('source_grounded_download_report.json');

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

function sha256File(filepath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filepath));
  return hash.digest('hex');
}

async function runCmd(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { maxBuffer: 20 * 1024 * 1024 });
}

async function waitForServer(baseUrl: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/system/status`);
      if (res.ok) return;
    } catch {
      // poll until ready
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for isolated test server at ${baseUrl}`);
}

function startIsolatedServer(): ChildProcess {
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  return spawn(tsxBin, ['server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      OWNER_PASSCODE: TEST_PASSCODE,
      SESSION_SECRET: TEST_SESSION_SECRET,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopServer(child: ChildProcess | null): Promise<void> {
  if (!child || child.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve();
    }, 4000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function generateMixedTimelineFixture(outPath: string): Promise<void> {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const seg1Path = path.join(TMP_DIR, 'seg1_active.mp4');
  const seg2Path = path.join(TMP_DIR, 'seg2_active.mp4');
  const seg3Path = path.join(TMP_DIR, 'seg3_frozen_silent.mp4');

  // Segment 1 (0 - 25s): High-detail animated testsrc2 + active overlay + 440Hz/880Hz audio (renders ~6-9MB MP4)
  await runCmd('ffmpeg', [
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:duration=25:rate=24',
    '-f', 'lavfi', '-i', 'aevalsrc=sin(440*2*PI*t)*0.20+sin(880*2*PI*t)*0.10:d=25',
    '-vf', [
      `drawtext=fontfile=${FONT_BOLD}:text='CHAPTER 1 - ACTIVE SPEAKER INSIGHT':x=80:y=160:fontsize=38:fontcolor=white:box=1:boxcolor=black@0.8:boxborderw=10`,
      `drawtext=fontfile=${FONT_REG}:text='Live Time %{pts\\:hms}':x=80+mod(t*45\\,420):y=280:fontsize=30:fontcolor=#38bdf8:box=1:boxcolor=black@0.6`,
    ].join(','),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-y', seg1Path,
  ]);

  // Segment 2 (25 - 55s): Distinct high-contrast color + animated text + 660Hz audio
  await runCmd('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=c=#064e3b:size=1280x720:duration=30:rate=24',
    '-f', 'lavfi', '-i', 'aevalsrc=sin(660*2*PI*t)*0.22:d=30',
    '-vf', [
      `drawtext=fontfile=${FONT_BOLD}:text='CHAPTER 2 - TECHNICAL DEMO':x=80:y=160:fontsize=38:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=10`,
      `drawtext=fontfile=${FONT_REG}:text='Frame %{n} | Time %{pts\\:hms}':x=100:y=300+sin(t*2)*80:fontsize=30:fontcolor=#fde047`,
    ].join(','),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-y', seg2Path,
  ]);

  // Segment 3 (55 - 75s): Static dead slate (identical every frame, non-black, distinct contrast transition at 55s) + pure silence
  await runCmd('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=c=#e2e8f0:size=1280x720:duration=20:rate=24',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=20',
    '-vf', `drawtext=fontfile=${FONT_REG}:text='STANDBY STATIC HOLD':x=120:y=260:fontsize=34:fontcolor=#1e293b`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-y', seg3Path,
  ]);

  const listPath = path.join(TMP_DIR, 'concat_mixed.txt');
  fs.writeFileSync(listPath, [seg1Path, seg2Path, seg3Path].map((p) => `file '${p}'`).join('\n'));
  await runCmd('ffmpeg', [
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', outPath,
  ]);
}

async function runTests() {
  const reporter = new DiagnosticReporter({
    reportPath: REPORT_PATH,
    preservePreviousReport: true,
    installSignalHandlers: true,
  });
  reporter.initialize();
  let testServer: ChildProcess | null = null;
  let token = '';
  let uploadedVideoId = '';
  const createdJobIds: string[] = [];

  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.mkdirSync(DL_DIR, { recursive: true });

    const fixturePath = path.join(TMP_DIR, 'mixed_timeline_75s.mp4');
    await generateMixedTimelineFixture(fixturePath);

    // ------------------------------------------------------------------
    // TEST 1: Metadata Probe, Scene Detection & Adaptive Frame Sampling
    // ------------------------------------------------------------------
    reporter.startTest('req1_metadata_and_adaptive_sampling');
    try {
      const probe = await probeVideo(fixturePath);
      assert(probe.width === 1280 && probe.height === 720, `Expected 1280x720, got ${probe.width}x${probe.height}`);
      assert(probe.duration >= 74 && probe.duration <= 76, `Expected ~75s duration, got ${probe.duration}`);
      assert(probe.hasAudio === true, 'Expected audio stream on fixture');

      const qualityCtx = await precomputeVideoQualityContext(fixturePath);
      assert(qualityCtx.sceneTransitions.length >= 2, `Expected >=2 scene transitions, got ${JSON.stringify(qualityCtx.sceneTransitions)}`);

      const frames = buildAdaptiveFrameTimestamps(0, probe.duration, qualityCtx.sceneTransitions, 18);
      assert(frames.length >= 8 && frames.length <= 18, `Expected 8..18 adaptive frames, got ${frames.length}`);
      assert(frames[0] < 10 && frames[frames.length - 1] > 55, `Adaptive frames did not cover full timeline: ${frames}`);
      const nearCut25 = frames.some((t) => t >= 25.0 && t <= 27.5);
      const nearCut55 = frames.some((t) => t >= 55.0 && t <= 57.5);
      assert(nearCut25 && nearCut55, `Expected post-transition frames near 25s and 55s, got ${frames}`);

      reporter.passTest('req1_metadata_and_adaptive_sampling', {
        details: { probe, sceneTransitions: qualityCtx.sceneTransitions, sampledTimestamps: frames },
      });
    } catch (err) {
      reporter.failTest('req1_metadata_and_adaptive_sampling', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // TEST 2: Interval Audio & Visual Progression (Past 60s Boundary)
    // ------------------------------------------------------------------
    reporter.startTest('req1_interval_audio_and_visual_motion');
    try {
      const activeAudio = await probeIntervalAudioActivity(fixturePath, 5, 22, true);
      assert(activeAudio.audioActive === true, `Expected active audio in [5, 22], got ${JSON.stringify(activeAudio)}`);

      const silentInterval = await probeIntervalAudioActivity(fixturePath, 57, 73, true);
      assert(silentInterval.audioActive === false, `Expected silent audio in [57, 73], got ${JSON.stringify(silentInterval)}`);

      const activeMotion = await inspectIntervalVisualProgression(fixturePath, 5, 22);
      assert(activeMotion.hasVisualProgression === true, `Expected visual motion in [5, 22], got ${JSON.stringify(activeMotion)}`);

      const frozenMotion = await inspectIntervalVisualProgression(fixturePath, 57, 73);
      assert(frozenMotion.hasVisualProgression === false, `Expected static/frozen detection in [57, 73], got ${JSON.stringify(frozenMotion)}`);

      reporter.passTest('req1_interval_audio_and_visual_motion', {
        details: { activeAudio, silentInterval, activeMotion, frozenMotion },
      });
    } catch (err) {
      reporter.failTest('req1_interval_audio_and_visual_motion', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // TEST 3: Anti-Fabrication & Independent Candidate Verification
    // ------------------------------------------------------------------
    reporter.startTest('req1_no_guessed_clips_verification');
    try {
      // A. Normalizer must NOT fabricate 0.88 confidence or generic filler reason
      const omittedConf = validateAndNormalizeCandidate(
        {
          title: 'Valid Topic Moment',
          hook: 'Strong question hook',
          startTime: 4,
          endTime: 22,
          factualDescription: 'Speaker demonstrates frame synchronization with live timecode.',
          visualEvidence: 'Dark slate background with moving cyan timecode counter.',
          reason: 'Clear topic arc with visual progression.',
        },
        75,
        0,
        75
      );
      assert(omittedConf !== null, 'Expected valid candidate with factualDescription');
      assert(omittedConf!.confidence === 0, `Expected omitted confidence to remain 0 (not coerced to 0.88), got ${omittedConf!.confidence}`);

      const noReasoning = validateAndNormalizeCandidate(
        {
          title: 'Guess without evidence',
          startTime: 4,
          endTime: 22,
        },
        75,
        0,
        75
      );
      assert(noReasoning === null, 'Expected candidate with empty reason & factualDescription to be rejected');

      // B. Frozen + silent segment [57, 73] must be rejected by evaluateCandidateVerification
      const ctx = await precomputeVideoQualityContext(fixturePath);
      const frozenQuality = await validateSegmentQuality(fixturePath, 57, 73, 75, 10, 60, ctx);
      const frozenSilentAudio = await probeIntervalAudioActivity(fixturePath, 57, 73, true);
      const frozenEval = evaluateCandidateVerification({
        candidate: {
          title: 'Standby Hold',
          hook: 'Wait',
          startTime: 57,
          endTime: 73,
          factualDescription: 'Standby slate',
          visualEvidence: 'Gray slate',
          reason: 'Slate',
          confidence: 0.9,
          category: 'Test',
          weakness: 'None',
          scores: {
            hookStrength: 5,
            audienceCuriosity: 5,
            informationalValue: 5,
            storyFlow: 5,
            standaloneContext: 5,
            payoff: 5,
            shareability: 5,
          },
        },
        qualityCheck: frozenQuality,
        isDecodable: true,
        editorialDurationValid: true,
        hasAudio: true,
        intervalAudio: frozenSilentAudio,
        transcriptAvailable: false,
        boundaryAdjusted: false,
      });
      assert(frozenEval.accepted === false && frozenEval.verificationStatus === 'rejected', 'Static+silent [57, 73] must be rejected');

      // C. Low confidence (<0.45) must be rejected
      const activeQuality = await validateSegmentQuality(fixturePath, 3, 23, 75, 15, 60, ctx);
      const activeAudio = await probeIntervalAudioActivity(fixturePath, 3, 23, true);
      const lowConfEval = evaluateCandidateVerification({
        candidate: { ...omittedConf!, confidence: 0.35 },
        qualityCheck: activeQuality,
        isDecodable: true,
        editorialDurationValid: true,
        hasAudio: true,
        intervalAudio: activeAudio,
        transcriptAvailable: false,
        boundaryAdjusted: false,
      });
      assert(lowConfEval.accepted === false && lowConfEval.verificationStatus === 'rejected', 'Confidence < 0.45 must be rejected');

      // D. Mismatched exact_quote vs interval transcript must be rejected
      const sampleSrt = `1\n00:00:02,000 --> 00:00:24,000\nSystem design relies on backpressure and queue isolation under spikes.\n`;
      const parsedSegs = parseTimestampedTranscript(sampleSrt);
      const aligned = alignClipWithTranscriptSegments({
        startTime: 3,
        endTime: 23,
        videoDuration: 75,
        segments: parsedSegs,
        editorialStyle: 'educational',
      });
      const mismatchQuoteEval = evaluateCandidateVerification({
        candidate: {
          ...omittedConf!,
          confidence: 0.85,
          exact_quote: 'Cooking pasta requires boiling salted water quickly',
        },
        qualityCheck: activeQuality,
        isDecodable: true,
        editorialDurationValid: true,
        hasAudio: true,
        intervalAudio: activeAudio,
        transcriptAvailable: true,
        transcriptSegmentText: aligned.transcriptText,
        boundaryAdjusted: false,
      });
      assert(mismatchQuoteEval.accepted === false && mismatchQuoteEval.verificationStatus === 'rejected', 'Mismatched quote must be rejected');

      // E. Audio video WITHOUT transcript must NEVER mark candidate 'verified'
      const noTranscriptEval = evaluateCandidateVerification({
        candidate: { ...omittedConf!, confidence: 0.85 },
        qualityCheck: activeQuality,
        isDecodable: true,
        editorialDurationValid: true,
        hasAudio: true,
        intervalAudio: activeAudio,
        transcriptAvailable: false,
        boundaryAdjusted: false,
      });
      assert(
        noTranscriptEval.accepted === true && noTranscriptEval.verificationStatus === 'uncertain',
        `Expected 'uncertain' without transcript on audio video, got ${noTranscriptEval.verificationStatus}`
      );
      assert(Boolean(noTranscriptEval.uncertaintyNote), 'Expected non-empty uncertaintyNote when transcript absent');

      // F. Fully verified candidate (motion + audio + aligned quote + factual/visual evidence + conf >= 0.7) -> 'verified'
      const decodableOk = await verifyDecodableRange(fixturePath, activeQuality.adjustedStartTime, activeQuality.adjustedEndTime);
      const verifiedEval = evaluateCandidateVerification({
        candidate: {
          ...omittedConf!,
          confidence: 0.86,
          exact_quote: 'System design relies on backpressure and queue isolation',
        },
        qualityCheck: activeQuality,
        isDecodable: decodableOk,
        editorialDurationValid: true,
        hasAudio: true,
        intervalAudio: activeAudio,
        transcriptAvailable: true,
        transcriptSegmentText: aligned.transcriptText,
        boundaryAdjusted: false,
      });
      assert(verifiedEval.accepted === true && verifiedEval.verificationStatus === 'verified', `Expected 'verified', got ${JSON.stringify(verifiedEval)}`);

      // Verify exact quote helper directly too
      const qOk = verifyExactQuoteMatchesInterval('backpressure and queue isolation', aligned.transcriptText);
      assert(qOk.matches === true, 'Expected quote helper match');

      reporter.passTest('req1_no_guessed_clips_verification', {
        details: {
          frozenRejectedReason: frozenEval.rejectionReason,
          lowConfRejectedReason: lowConfEval.rejectionReason,
          mismatchRejectedReason: mismatchQuoteEval.rejectionReason,
          noTranscriptStatus: noTranscriptEval.verificationStatus,
          verifiedStatus: verifiedEval.verificationStatus,
        },
      });
    } catch (err) {
      reporter.failTest('req1_no_guessed_clips_verification', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // TEST 4: Permanent Local Download, HTTP Headers, 409 Lock During Active Transfer & Survival After Delete
    // ------------------------------------------------------------------
    reporter.startTest('req2_permanent_download_and_active_transfer_lock');
    try {
      testServer = startIsolatedServer();
      await waitForServer(TEST_API_BASE, 20000);

      // Login
      const loginRes = await fetch(`${TEST_API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: TEST_PASSCODE }),
      });
      const loginJson = await loginRes.json();
      assert(loginRes.ok && loginJson.token, `Login failed: ${JSON.stringify(loginJson)}`);
      token = loginJson.token;

      // Upload fixture
      const form = new FormData();
      form.append('video', new Blob([fs.readFileSync(fixturePath)], { type: 'video/mp4' }), 'mixed_timeline_75s.mp4');
      const uploadRes = await fetch(`${TEST_API_BASE}/api/videos/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const uploadJson = await uploadRes.json();
      assert(uploadRes.ok && uploadJson.video?.id, `Upload failed: ${JSON.stringify(uploadJson)}`);
      uploadedVideoId = uploadJson.video.id;

      // Render a real clip from verified interval [5, 22]
      const renderRes = await fetch(`${TEST_API_BASE}/api/clips/render`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sourceVideoId: uploadedVideoId,
          title: 'Active Insight Segment',
          startTime: 5,
          endTime: 22,
          aspectRatio: '9:16',
        }),
      });
      const renderJson = await renderRes.json();
      assert(renderRes.status === 202 && renderJson.job?.id, `Render queue failed: ${JSON.stringify(renderJson)}`);
      const jobId = renderJson.job.id as string;
      createdJobIds.push(jobId);

      // Wait until render completes
      let completedJob: any = null;
      const pollDeadline = Date.now() + 45000;
      while (Date.now() < pollDeadline) {
        const stRes = await fetch(`${TEST_API_BASE}/api/clips/status/${jobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const stJson = await stRes.json();
        if (stJson.job?.status === 'completed') {
          completedJob = stJson.job;
          break;
        }
        if (stJson.job?.status === 'failed') {
          throw new Error(`Render job failed: ${stJson.job.error}`);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      assert(Boolean(completedJob), 'Render job timed out before completion');
      const serverOutputPath = completedJob.outputPath as string;
      assert(fs.existsSync(serverOutputPath), `Server rendered MP4 missing: ${serverOutputPath}`);

      // Simulate slow/in-flight download stream and verify DELETE returns 409 Conflict mid-transfer
      const localCopyPath = path.join(DL_DIR, `${jobId}_permanent_local.mp4`);
      const downloadMetrics = await new Promise<{
        statusCode: number;
        headers: Record<string, string | string[] | undefined>;
        conflictStatusMidStream: number;
        receivedBytes: number;
        expectedContentLength: number;
      }>((resolve, reject) => {
        const req = http.get(
          `${TEST_API_BASE}/api/clips/download/${jobId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
          (res) => {
            const statusCode = res.statusCode || 0;
            const expectedLen = parseInt(String(res.headers['content-length'] || '0'), 10);
            const chunks: Buffer[] = [];
            let triggeredMidStreamDelete = false;
            let conflictStatus = 0;

            res.on('data', async (chunk: Buffer) => {
              chunks.push(chunk);
              if (!triggeredMidStreamDelete) {
                triggeredMidStreamDelete = true;
                res.pause();
                try {
                  // Attempt DELETE while stream is paused and open
                  const conflictRes = await fetch(`${TEST_API_BASE}/api/clips/render/${jobId}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${token}` },
                  });
                  conflictStatus = conflictRes.status;
                } catch (err) {
                  reject(err);
                  return;
                }
                res.resume();
              }
            });

            res.on('end', () => {
              const fullBuf = Buffer.concat(chunks);
              fs.writeFileSync(localCopyPath, fullBuf);
              resolve({
                statusCode,
                headers: res.headers,
                conflictStatusMidStream: conflictStatus,
                receivedBytes: fullBuf.length,
                expectedContentLength: expectedLen,
              });
            });

            res.on('error', reject);
          }
        );
        req.on('error', reject);
      });

      assert(downloadMetrics.statusCode === 200, `Expected HTTP 200 on download, got ${downloadMetrics.statusCode}`);
      const disp = String(downloadMetrics.headers['content-disposition'] || '');
      const cacheCtl = String(downloadMetrics.headers['cache-control'] || '');
      assert(disp.startsWith('attachment; filename='), `Expected attachment Content-Disposition, got ${disp}`);
      assert(downloadMetrics.headers['content-type'] === 'video/mp4', `Expected video/mp4 content-type`);
      assert(cacheCtl.includes('no-store'), `Expected no-store Cache-Control, got ${cacheCtl}`);
      assert(
        downloadMetrics.expectedContentLength > 0 && downloadMetrics.receivedBytes === downloadMetrics.expectedContentLength,
        `Byte mismatch: got ${downloadMetrics.receivedBytes}, expected ${downloadMetrics.expectedContentLength}`
      );
      assert(
        downloadMetrics.conflictStatusMidStream === 409,
        `Expected HTTP 409 Conflict deleting during active download, got ${downloadMetrics.conflictStatusMidStream}`
      );
      assert(fs.existsSync(serverOutputPath), 'Server MP4 must still exist after blocked 409 delete');

      const localShaBeforeDelete = sha256File(localCopyPath);

      // Wait a tiny beat for 'close'/'finish' event cleanup on server, then delete server render
      await new Promise((r) => setTimeout(r, 150));
      const delRes = await fetch(`${TEST_API_BASE}/api/clips/render/${jobId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert(delRes.status === 200, `Expected HTTP 200 deleting completed non-active render, got ${delRes.status}`);
      assert(!fs.existsSync(serverOutputPath), 'Server MP4 should be deleted from disk after DELETE 200');

      const afterDelDl = await fetch(`${TEST_API_BASE}/api/clips/download/${jobId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert(afterDelDl.status === 404, `Expected 404 on server download after delete, got ${afterDelDl.status}`);

      // Verify local downloaded copy is completely intact and playable after server deletion
      assert(fs.existsSync(localCopyPath), 'Local downloaded MP4 must still exist after server render deletion');
      assert(sha256File(localCopyPath) === localShaBeforeDelete, 'Local downloaded MP4 SHA-256 changed after delete');

      const { stderr: decodeErr } = await runCmd('ffmpeg', ['-v', 'error', '-i', localCopyPath, '-f', 'null', '-']);
      assert(decodeErr.trim().length === 0, `Local downloaded MP4 failed FFmpeg decode: ${decodeErr}`);

      const localProbe = await probeVideo(localCopyPath);
      assert(localProbe.width === 1080 && localProbe.height === 1920, `Expected 1080x1920 MP4, got ${localProbe.width}x${localProbe.height}`);
      assert(localProbe.duration >= 16.5 && localProbe.duration <= 17.5, `Expected ~17s clip, got ${localProbe.duration}`);

      reporter.passTest('req2_permanent_download_and_active_transfer_lock', {
        details: {
          jobId,
          contentLength: downloadMetrics.expectedContentLength,
          receivedBytes: downloadMetrics.receivedBytes,
          conflictStatusDuringTransfer: downloadMetrics.conflictStatusMidStream,
          serverDeleteAfterTransfer: 200,
          localSha256: localShaBeforeDelete,
          localDecodedDuration: localProbe.duration,
          localResolution: `${localProbe.width}x${localProbe.height}`,
        },
      });
    } catch (err) {
      reporter.failTest('req2_permanent_download_and_active_transfer_lock', err);
      throw err;
    }

    const snap = reporter.finalize('completed');
    console.log(`\n✓ Source-Grounded & Permanent Download tests passed (${snap.summary.passed}/${snap.summary.total})`);
  } finally {
    if (testServer && token) {
      for (const jId of createdJobIds) {
        await fetch(`${TEST_API_BASE}/api/clips/render/${jId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
      if (uploadedVideoId) {
        await fetch(`${TEST_API_BASE}/api/videos/${uploadedVideoId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    }
    await stopServer(testServer);
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('❌ SOURCE-GROUNDED & DOWNLOAD VERIFICATION FAILED:', err);
  process.exit(1);
});
