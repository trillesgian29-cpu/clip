import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { DiagnosticReporter } from './lib/diagnosticReporter.ts';

dotenv.config();

const execFileAsync = promisify(execFile);
const LIVE_SERVER_BASE = 'http://localhost:3000';
const TEST_PORT = 3105;
const TEST_API_BASE = `http://localhost:${TEST_PORT}`;
const TEST_PASSCODE = 'cp4-e2e-verify-owner-2026';
const TEST_SESSION_SECRET = 'cp4-e2e-verify-session-2026';
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const TMP_DIR = path.resolve('uploads/tmp_cp4');
const DL_DIR = path.join(TMP_DIR, 'downloads');
const REPORT_PATH = path.resolve('checkpoint4_security_report.json');

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
      // keep polling until ready
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error(`Timed out waiting for server at ${baseUrl}`);
}

function startIsolatedServer(): ChildProcess {
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  const child = spawn(tsxBin, ['server.ts'], {
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
  return child;
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

async function probeAndFullDecodeMp4(filepath: string, expectedMinDur: number, expectedMaxDur: number) {
  assert(fs.existsSync(filepath), `MP4 file missing: ${filepath}`);
  const { stdout: probeOut } = await runCmd('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    filepath,
  ]);
  const probe = JSON.parse(probeOut);
  const vStream = probe.streams?.find((s: any) => s.codec_type === 'video');
  const aStream = probe.streams?.find((s: any) => s.codec_type === 'audio');
  const duration = parseFloat(probe.format?.duration || '0');

  assert(Boolean(vStream), `No video stream found in ${filepath}`);
  assert(Boolean(aStream), `No audio stream found in ${filepath}`);
  assert(vStream.width === 1080 && vStream.height === 1920, `Expected 1080x1920, got ${vStream.width}x${vStream.height}`);
  assert(
    duration >= expectedMinDur && duration <= expectedMaxDur,
    `Duration ${duration.toFixed(2)}s outside expected [${expectedMinDur.toFixed(2)}s, ${expectedMaxDur.toFixed(2)}s]`
  );

  // Full frame-by-frame decode validation
  const { stderr: decodeErr } = await runCmd('ffmpeg', ['-v', 'error', '-i', filepath, '-f', 'null', '-']);
  assert(decodeErr.trim().length === 0, `FFmpeg decode errors in ${filepath}: ${decodeErr.trim()}`);

  return {
    width: vStream.width,
    height: vStream.height,
    codec: vStream.codec_name,
    audioCodec: aStream.codec_name,
    duration: Math.round(duration * 100) / 100,
    bytes: fs.statSync(filepath).size,
  };
}

async function generateMultiChapterFixture(outPath: string): Promise<void> {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const chapters = [
    { idx: 1, color: '#0f172a', dur: 12.5, title: 'SEGMENT 1: HOOK AND TENSION' },
    { idx: 2, color: '#1e1b4b', dur: 12.5, title: 'SEGMENT 2: CORE INSIGHT' },
    { idx: 3, color: '#064e3b', dur: 12.5, title: 'SEGMENT 3: LIVE DEMONSTRATION' },
    { idx: 4, color: '#451a03', dur: 12.5, title: 'SEGMENT 4: PAYOFF CONCLUSION' },
  ];

  const parts: string[] = [];
  for (const ch of chapters) {
    const partPath = path.join(TMP_DIR, `part_${ch.idx}.mp4`);
    const vf = [
      `drawtext=fontfile=${FONT_BOLD}:text='${ch.title}':x=70:y=220:fontsize=38:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=10`,
      `drawtext=fontfile=${FONT_REG}:text='Time %{pts\\:hms}':x=70:y=340:fontsize=28:fontcolor=#fde047`,
    ].join(',');
    await runCmd('ffmpeg', [
      '-f', 'lavfi', '-i', `color=c=${ch.color}:size=1280x720:duration=${ch.dur}:rate=24`,
      '-f', 'lavfi', '-i', `aevalsrc=sin(${220 + ch.idx * 65}*2*PI*t)*0.16:d=${ch.dur}`,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k',
      '-y', partPath,
    ]);
    parts.push(partPath);
  }

  const listPath = path.join(TMP_DIR, 'concat.txt');
  fs.writeFileSync(listPath, parts.map((p) => `file '${p}'`).join('\n'));
  await runCmd('ffmpeg', [
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', outPath,
  ]);
}

async function loginOwner(baseUrl: string, passcode: string): Promise<{ token: string; cookieHeader: string }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  const data = await res.json();
  assert(res.ok && data?.token, `Owner login failed (${res.status}): ${JSON.stringify(data)}`);
  const setCookie = res.headers.get('set-cookie') || '';
  assert(setCookie.includes('session_token='), `Expected HttpOnly session_token cookie, got: ${setCookie}`);
  const cookiePair = setCookie.split(';')[0];
  return { token: data.token, cookieHeader: cookiePair };
}

async function verifyUnauthGatesOnServer(baseUrl: string): Promise<number> {
  const unauthRoutes: Array<{ method: string; url: string; body?: string }> = [
    { method: 'GET', url: '/api/videos' },
    { method: 'GET', url: '/api/videos/stream/fake-id' },
    { method: 'HEAD', url: '/api/videos/stream/fake-id' },
    { method: 'GET', url: '/api/thumbnails/fake-id' },
    { method: 'GET', url: '/api/thumbnails/clip/fake-id?t=1' },
    { method: 'GET', url: '/api/clips/jobs' },
    { method: 'POST', url: '/api/clips/render', body: '{}' },
    { method: 'POST', url: '/api/clips/batch-render', body: '{}' },
    { method: 'GET', url: '/api/clips/status/fake-job' },
    { method: 'GET', url: '/api/clips/download/fake-job' },
    { method: 'GET', url: '/api/clips/stream/fake-job' },
    { method: 'HEAD', url: '/api/clips/stream/fake-job' },
    { method: 'DELETE', url: '/api/clips/render/fake-job' },
    { method: 'DELETE', url: '/api/videos/fake-id' },
    { method: 'POST', url: '/api/ai/analyze', body: '{}' },
    { method: 'GET', url: '/api/projects' },
    { method: 'GET', url: '/api/clips/published' },
  ];

  for (const r of unauthRoutes) {
    const res = await fetch(`${baseUrl}${r.url}`, {
      method: r.method,
      headers: r.body ? { 'Content-Type': 'application/json' } : undefined,
      body: r.body,
    });
    assert(res.status === 401, `Expected 401 for unauth ${r.method} ${r.url} on ${baseUrl}, got ${res.status}`);
  }

  const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'wrong-passcode-123' }),
  });
  assert(badLogin.status === 401, `Expected 401 for wrong passcode on ${baseUrl}, got ${badLogin.status}`);
  return unauthRoutes.length;
}

async function runVerification() {
  const reporter = new DiagnosticReporter({
    reportPath: REPORT_PATH,
    preservePreviousReport: true,
    installSignalHandlers: true,
  });
  reporter.initialize();

  console.log('========================================================================');
  console.log('CLIPGENIUS AI — CHECKPOINT 4A–4E & FINAL SECURITY VERIFICATION SUITE');
  console.log('========================================================================\n');

  let testServer: ChildProcess | null = null;
  let videoId = '';
  let jobIds: string[] = [];
  let failedJobId = '';
  let validExtraJobId = '';
  let activeToken = '';

  const uploadedDir = path.resolve('uploads');
  const renderedDir = path.resolve('rendered');
  const preExistingUploads = fs.existsSync(uploadedDir) ? fs.readdirSync(uploadedDir) : [];
  const preExistingRendered = fs.existsSync(renderedDir) ? fs.readdirSync(renderedDir) : [];

  try {
    // ------------------------------------------------------------------
    // 1. Live Server (Port 3000) Unauthenticated 401 Enforcement + Test Server Auth
    // ------------------------------------------------------------------
    reporter.startTest('cp_final_security_auth_gates');
    let liveUnauthChecked = 0;
    try {
      await waitForServer(LIVE_SERVER_BASE, 10000);
      liveUnauthChecked = await verifyUnauthGatesOnServer(LIVE_SERVER_BASE);

      testServer = startIsolatedServer();
      await waitForServer(TEST_API_BASE, 20000);
      await verifyUnauthGatesOnServer(TEST_API_BASE);

      const { token, cookieHeader } = await loginOwner(TEST_API_BASE, TEST_PASSCODE);
      activeToken = token;

      const checkBearer = await fetch(`${TEST_API_BASE}/api/auth/check`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert((await checkBearer.json()).authenticated === true, 'Bearer token failed /api/auth/check');

      const checkCookie = await fetch(`${TEST_API_BASE}/api/auth/check`, {
        headers: { Cookie: cookieHeader },
      });
      assert((await checkCookie.json()).authenticated === true, 'Session cookie failed /api/auth/check');

      const badIdChecks = [
        '/api/videos/item/bad$id',
        '/api/clips/status/..%2Fetc',
        '/api/clips/download/bad!job',
        '/api/thumbnails/..%2F.env',
      ];
      for (const badUrl of badIdChecks) {
        const res = await fetch(`${TEST_API_BASE}${badUrl}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert(res.status === 400 || res.status === 404, `Expected 400/404 for ${badUrl}, got ${res.status}`);
      }

      reporter.passTest('cp_final_security_auth_gates', {
        details: {
          liveServerPort3000UnauthRoutes401: liveUnauthChecked,
          cookieAuthVerified: true,
          bearerAuthVerified: true,
          invalidIdChecksPassed: badIdChecks.length,
        },
      });
    } catch (err) {
      reporter.failTest('cp_final_security_auth_gates', err);
      throw err;
    }

    const { token, cookieHeader } = await loginOwner(TEST_API_BASE, TEST_PASSCODE);
    activeToken = token;

    // Generate & upload clean 50s fixture
    const fixturePath = path.join(TMP_DIR, 'cp4_source_50s.mp4');
    await generateMultiChapterFixture(fixturePath);
    const buf = fs.readFileSync(fixturePath);
    const form = new FormData();
    form.append('video', new Blob([buf], { type: 'video/mp4' }), 'cp4_multi_segment_50s.mp4');

    const uploadRes = await fetch(`${TEST_API_BASE}/api/videos/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Connection: 'close' },
      body: form,
    });
    const uploadData = await uploadRes.json();
    assert(uploadRes.ok && uploadData?.video?.id, `Upload failed: ${JSON.stringify(uploadData)}`);
    videoId = uploadData.video.id;

    // ------------------------------------------------------------------
    // 2. CP-4A: Independent Render Jobs (4 valid + 1 invalid/1 valid isolated batch)
    // ------------------------------------------------------------------
    reporter.startTest('cp_4a_independent_batch_render_and_isolation');
    const clipSpecs = [
      { clipId: 'cp4-c1', sourceVideoId: videoId, title: 'Segment 1 Hook', startTime: 0, endTime: 10, aspectRatio: '9:16' as const },
      { clipId: 'cp4-c2', sourceVideoId: videoId, title: 'Segment 2 Insight', startTime: 12, endTime: 24, aspectRatio: '9:16' as const },
      { clipId: 'cp4-c3', sourceVideoId: videoId, title: 'Segment 3 Demo', startTime: 25, endTime: 37, aspectRatio: '9:16' as const },
      { clipId: 'cp4-c4', sourceVideoId: videoId, title: 'Segment 4 Payoff', startTime: 38, endTime: 49, aspectRatio: '9:16' as const },
    ];
    const serverRenderPaths: Record<string, string> = {};

    try {
      const batchRes = await fetch(`${TEST_API_BASE}/api/clips/batch-render`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ clips: clipSpecs, defaultAspectRatio: '9:16' }),
      });
      const batchData = await batchRes.json();
      assert(batchRes.status === 202 && Array.isArray(batchData.jobs) && batchData.jobs.length === 4, 'Expected 4 render jobs queued');

      const uniqueIds = new Set(batchData.jobs.map((j: any) => j.id));
      assert(uniqueIds.size === 4, 'Render job IDs must all be unique');
      jobIds = batchData.jobs.map((j: any) => j.id);

      for (let i = 0; i < clipSpecs.length; i++) {
        assert(batchData.jobs[i].startTime === clipSpecs[i].startTime, `Start time drifted on job ${i}`);
        assert(batchData.jobs[i].endTime === clipSpecs[i].endTime, `End time drifted on job ${i}`);
      }

      for (const jId of jobIds) {
        let current: any = null;
        for (let attempt = 0; attempt < 90; attempt++) {
          const stRes = await fetch(`${TEST_API_BASE}/api/clips/status/${jId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          current = (await stRes.json()).job;
          if (current?.status === 'completed' || current?.status === 'failed') break;
          await new Promise((r) => setTimeout(r, 400));
        }
        assert(current?.status === 'completed', `Job ${jId} failed or timed out: ${current?.status} (${current?.error})`);
        const outPath = path.join(renderedDir, current.outputFilename);
        assert(fs.existsSync(outPath), `Rendered file missing on disk: ${outPath}`);
        serverRenderPaths[jId] = outPath;
      }

      // Isolated failure batch
      const isoRes = await fetch(`${TEST_API_BASE}/api/clips/batch-render`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          clips: [
            { clipId: 'bad-clip', sourceVideoId: 'nonexistent_source_999', title: 'Missing Video Clip', startTime: 0, endTime: 10 },
            { clipId: 'iso-valid', sourceVideoId: videoId, title: 'Isolated Valid Clip', startTime: 2, endTime: 9 },
          ],
          defaultAspectRatio: '9:16',
        }),
      });
      const isoData = await isoRes.json();
      assert(isoRes.status === 202 && isoData.jobs.length === 2, 'Expected explicit job records for both invalid and valid clips');
      assert(isoData.jobs[0].status === 'failed' && Boolean(isoData.jobs[0].error), 'Invalid clip must produce explicit failed job (never silently skipped)');
      failedJobId = isoData.jobs[0].id;
      validExtraJobId = isoData.jobs[1].id;

      let extraFinal: any = null;
      for (let attempt = 0; attempt < 90; attempt++) {
        const stRes = await fetch(`${TEST_API_BASE}/api/clips/status/${validExtraJobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        extraFinal = (await stRes.json()).job;
        if (extraFinal?.status === 'completed' || extraFinal?.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 400));
      }
      assert(extraFinal?.status === 'completed', `Valid clip in mixed batch failed: ${extraFinal?.error}`);
      serverRenderPaths[validExtraJobId] = path.join(renderedDir, extraFinal.outputFilename);

      reporter.passTest('cp_4a_independent_batch_render_and_isolation', {
        details: { jobIds, failedJobId, validExtraJobId },
      });
    } catch (err) {
      reporter.failTest('cp_4a_independent_batch_render_and_isolation', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 3. CP-4B: Individual Clip Previews & HTTP 206 / 416 Streaming
    // ------------------------------------------------------------------
    reporter.startTest('cp_4b_previews_and_range_streaming');
    try {
      const srcHead = await fetch(`${TEST_API_BASE}/api/videos/stream/${videoId}`, {
        method: 'HEAD',
        headers: { Cookie: cookieHeader },
      });
      assert(srcHead.status === 200 && srcHead.headers.get('accept-ranges') === 'bytes', 'Source HEAD missing Accept-Ranges: bytes');

      const previewAudit: any[] = [];
      for (let i = 0; i < clipSpecs.length; i++) {
        const spec = clipSpecs[i];
        const jId = jobIds[i];

        const thumbRes = await fetch(`${TEST_API_BASE}/api/thumbnails/clip/${videoId}?t=${Math.round(spec.startTime)}`, {
          headers: { Cookie: cookieHeader },
        });
        const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
        assert(
          thumbRes.status === 200 &&
            (thumbRes.headers.get('content-type') || '').includes('image/jpeg') &&
            thumbBuf.length > 1000 &&
            thumbBuf[0] === 0xff &&
            thumbBuf[1] === 0xd8,
          `Invalid JPEG thumbnail for clip ${spec.clipId}`
        );

        const headRes = await fetch(`${TEST_API_BASE}/api/clips/stream/${jId}`, {
          method: 'HEAD',
          headers: { Cookie: cookieHeader },
        });
        assert(
          headRes.status === 200 &&
            headRes.headers.get('accept-ranges') === 'bytes' &&
            (headRes.headers.get('content-type') || '').includes('video/mp4'),
          `Rendered clip HEAD invalid for ${jId}`
        );

        const fullRes = await fetch(`${TEST_API_BASE}/api/clips/stream/${jId}`, {
          headers: { Cookie: cookieHeader },
        });
        assert(
          fullRes.status === 200 &&
            fullRes.headers.get('accept-ranges') === 'bytes' &&
            (fullRes.headers.get('content-type') || '').includes('video/mp4'),
          `Rendered clip GET 200 invalid for ${jId}`
        );
        await fullRes.arrayBuffer();

        const partialRes = await fetch(`${TEST_API_BASE}/api/clips/stream/${jId}`, {
          headers: { Cookie: cookieHeader, Range: 'bytes=0-32767' },
        });
        assert(
          partialRes.status === 206 &&
            (partialRes.headers.get('content-type') || '').includes('video/mp4') &&
            Boolean(partialRes.headers.get('content-range')?.startsWith('bytes 0-32767/')),
          `Expected HTTP 206 video/mp4 range response for ${jId}, got ${partialRes.status}`
        );
        await partialRes.arrayBuffer();

        const badRangeRes = await fetch(`${TEST_API_BASE}/api/clips/stream/${jId}`, {
          headers: { Cookie: cookieHeader, Range: 'bytes=999999999-' },
        });
        assert(badRangeRes.status === 416, `Expected 416 Range Not Satisfiable for ${jId}, got ${badRangeRes.status}`);

        previewAudit.push({
          jobId: jId,
          thumbBytes: thumbBuf.length,
          headStatus: headRes.status,
          get200Status: fullRes.status,
          range206Status: partialRes.status,
          range416Status: badRangeRes.status,
        });
      }

      reporter.passTest('cp_4b_previews_and_range_streaming', { details: { previewAudit } });
    } catch (err) {
      reporter.failTest('cp_4b_previews_and_range_streaming', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 4. CP-4C: Server-Side Output MP4 Validation (ffprobe + full ffmpeg decode)
    // ------------------------------------------------------------------
    reporter.startTest('cp_4c_mp4_probe_and_full_decode');
    try {
      const probedClips: any[] = [];
      for (let i = 0; i < jobIds.length; i++) {
        const jId = jobIds[i];
        const expectedDur = clipSpecs[i].endTime - clipSpecs[i].startTime;
        const stats = await probeAndFullDecodeMp4(serverRenderPaths[jId], expectedDur - 0.6, expectedDur + 0.6);
        probedClips.push({ jobId: jId, ...stats });
      }
      reporter.passTest('cp_4c_mp4_probe_and_full_decode', { details: { probedClips } });
    } catch (err) {
      reporter.failTest('cp_4c_mp4_probe_and_full_decode', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 5. CP-4D Part 1: HTTP Download + SHA-256 + Full Local Decode
    // ------------------------------------------------------------------
    reporter.startTest('cp_4d_http_download_sha256_and_decode');
    fs.mkdirSync(DL_DIR, { recursive: true });
    const downloadPaths: Record<string, string> = {};
    const downloadHashes: Record<string, string> = {};

    try {
      const downloadsAudit: any[] = [];
      for (let i = 0; i < jobIds.length; i++) {
        const jId = jobIds[i];
        const dlRes = await fetch(`${TEST_API_BASE}/api/clips/download/${jId}`, {
          headers: { Cookie: cookieHeader },
        });
        assert(dlRes.status === 200, `Download failed for ${jId}: HTTP ${dlRes.status}`);
        assert((dlRes.headers.get('content-type') || '').includes('video/mp4'), `Expected video/mp4 Content-Type for download ${jId}`);
        assert((dlRes.headers.get('content-disposition') || '').includes('attachment;'), `Missing attachment header for ${jId}`);

        const dlBuf = Buffer.from(await dlRes.arrayBuffer());
        const localPath = path.join(DL_DIR, `local_${jId}.mp4`);
        fs.writeFileSync(localPath, dlBuf);

        const serverHash = sha256File(serverRenderPaths[jId]);
        const localHash = sha256File(localPath);
        assert(serverHash === localHash, `SHA-256 mismatch between server MP4 and downloaded file for ${jId}`);

        const expectedDur = clipSpecs[i].endTime - clipSpecs[i].startTime;
        const stats = await probeAndFullDecodeMp4(localPath, expectedDur - 0.6, expectedDur + 0.6);

        downloadPaths[jId] = localPath;
        downloadHashes[jId] = localHash;
        downloadsAudit.push({ jobId: jId, sha256: localHash, ...stats });
      }

      reporter.passTest('cp_4d_http_download_sha256_and_decode', { details: { downloadsAudit } });
    } catch (err) {
      reporter.failTest('cp_4d_http_download_sha256_and_decode', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 6. CP-4A Restart Persistence: SIGTERM server -> Start fresh PID -> Re-verify
    // ------------------------------------------------------------------
    reporter.startTest('cp_4a_restart_persistence');
    let postRestartToken = '';
    let postRestartCookie = '';
    try {
      const oldPid = testServer?.pid;
      await stopServer(testServer);
      testServer = startIsolatedServer();
      const newPid = testServer.pid;
      assert(Boolean(newPid && newPid !== oldPid), 'Restarted server did not spawn new OS PID');
      await waitForServer(TEST_API_BASE, 20000);

      // Even prior HMAC-signed cookie/token remains valid across restart!
      const oldTokenCheck = await fetch(`${TEST_API_BASE}/api/auth/check`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert((await oldTokenCheck.json()).authenticated === true, 'HMAC session token did not survive server restart');

      const loginAfter = await loginOwner(TEST_API_BASE, TEST_PASSCODE);
      postRestartToken = loginAfter.token;
      postRestartCookie = loginAfter.cookieHeader;
      activeToken = postRestartToken;

      const jobsRes = await fetch(`${TEST_API_BASE}/api/clips/jobs`, {
        headers: { Authorization: `Bearer ${postRestartToken}` },
      });
      assert(jobsRes.ok, `GET /api/clips/jobs failed after restart: ${jobsRes.status}`);
      const jobsData = await jobsRes.json();
      const jobMap = new Map<string, any>((jobsData.jobs || []).map((j: any) => [j.id, j]));

      for (const jId of jobIds) {
        const persisted = jobMap.get(jId);
        assert(persisted && persisted.status === 'completed', `Job ${jId} did not survive server restart as completed`);
        const stRes = await fetch(`${TEST_API_BASE}/api/clips/status/${jId}`, {
          headers: { Authorization: `Bearer ${postRestartToken}` },
        });
        assert(stRes.status === 200, `Status route failed after restart for ${jId}`);

        const headRes = await fetch(`${TEST_API_BASE}/api/clips/stream/${jId}`, {
          method: 'HEAD',
          headers: { Cookie: postRestartCookie },
        });
        assert(headRes.status === 200, `Stream HEAD failed after restart for ${jId}`);
      }

      const persistedFailed = jobMap.get(failedJobId);
      assert(persistedFailed && persistedFailed.status === 'failed', 'Failed job record did not persist across restart');

      reporter.passTest('cp_4a_restart_persistence', {
        details: {
          oldPid,
          newPid,
          sessionSurvivedRestart: true,
          persistedCompletedJobs: jobIds.length,
          persistedFailedJob: failedJobId,
        },
      });
    } catch (err) {
      reporter.failTest('cp_4a_restart_persistence', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 7. CP-4D Part 2 & CP-4E: Delete Server Render, Local Independence & Storage Isolation
    // ------------------------------------------------------------------
    reporter.startTest('cp_4d_4e_delete_isolation_and_local_independence');
    try {
      const targetDeleteId = jobIds[0];
      const targetServerPath = serverRenderPaths[targetDeleteId];
      const targetLocalPath = downloadPaths[targetDeleteId];
      const expectedHash = downloadHashes[targetDeleteId];

      const delRes = await fetch(`${TEST_API_BASE}/api/clips/render/${targetDeleteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${postRestartToken}` },
      });
      assert(delRes.status === 200, `Delete server render failed: ${delRes.status}`);
      assert(!fs.existsSync(targetServerPath), `Server MP4 still exists after DELETE: ${targetServerPath}`);

      const goneStatus = await fetch(`${TEST_API_BASE}/api/clips/status/${targetDeleteId}`, {
        headers: { Authorization: `Bearer ${postRestartToken}` },
      });
      assert(goneStatus.status === 404, `Deleted job status should return 404, got ${goneStatus.status}`);

      const goneDownload = await fetch(`${TEST_API_BASE}/api/clips/download/${targetDeleteId}`, {
        headers: { Authorization: `Bearer ${postRestartToken}` },
      });
      assert(goneDownload.status === 404, `Deleted job download should return 404, got ${goneDownload.status}`);

      const missingDel = await fetch(`${TEST_API_BASE}/api/clips/render/${targetDeleteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${postRestartToken}` },
      });
      assert(missingDel.status === 404, `Deleting missing job should return 404, got ${missingDel.status}`);

      // Verify local downloaded file STILL exists, matches SHA-256, and still decodes cleanly
      assert(fs.existsSync(targetLocalPath), 'Local downloaded MP4 disappeared after server delete');
      assert(sha256File(targetLocalPath) === expectedHash, 'Local downloaded MP4 mutated after server delete');
      const decodedLocal = await probeAndFullDecodeMp4(targetLocalPath, 9.4, 10.6);

      // Verify unrelated renders and source video remain completely intact
      for (const survivingId of jobIds.slice(1)) {
        assert(fs.existsSync(serverRenderPaths[survivingId]), `Unrelated render ${survivingId} was deleted!`);
        const rangeRes = await fetch(`${TEST_API_BASE}/api/clips/stream/${survivingId}`, {
          headers: { Cookie: postRestartCookie, Range: 'bytes=0-1023' },
        });
        assert(rangeRes.status === 206, `Unrelated render ${survivingId} stream broken after deleting ${targetDeleteId}`);
        await rangeRes.arrayBuffer();
      }

      const srcRange = await fetch(`${TEST_API_BASE}/api/videos/stream/${videoId}`, {
        headers: { Cookie: postRestartCookie, Range: 'bytes=0-1023' },
      });
      assert(srcRange.status === 206, 'Source video stream broken after deleting a render');
      await srcRange.arrayBuffer();

      const currentRendered = new Set(fs.existsSync(renderedDir) ? fs.readdirSync(renderedDir) : []);
      for (const preFile of preExistingRendered) {
        assert(currentRendered.has(preFile), `Pre-existing user rendered file ${preFile} was modified/removed!`);
      }

      const currentUploads = new Set(fs.existsSync(uploadedDir) ? fs.readdirSync(uploadedDir) : []);
      for (const preFile of preExistingUploads) {
        if (preFile === 'tmp_cp4') continue;
        assert(currentUploads.has(preFile), `Pre-existing upload file ${preFile} was modified/removed!`);
      }

      reporter.passTest('cp_4d_4e_delete_isolation_and_local_independence', {
        details: {
          deletedJobId: targetDeleteId,
          localDecodedAfterServerDelete: decodedLocal,
          unrelatedRendersVerifiedIntact: jobIds.slice(1).length,
          preExistingRendersPreserved: preExistingRendered.length,
        },
      });
    } catch (err) {
      reporter.failTest('cp_4d_4e_delete_isolation_and_local_independence', err);
      throw err;
    }

    const snap = reporter.finalize('completed');
    console.log(`\n✓ Saved CP4 & Security report to ${REPORT_PATH}`);
    console.log(`Summary: passed=${snap.summary.passed}, failed=${snap.summary.failed}, skipped=${snap.summary.skipped}`);
  } finally {
    if (testServer && activeToken) {
      for (const jId of [...jobIds, failedJobId, validExtraJobId].filter(Boolean)) {
        await fetch(`${TEST_API_BASE}/api/clips/render/${jId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${activeToken}` },
        }).catch(() => {});
      }
      if (videoId) {
        await fetch(`${TEST_API_BASE}/api/videos/${videoId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${activeToken}` },
        }).catch(() => {});
      }
    }
    await stopServer(testServer);
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

runVerification().catch((err) => {
  console.error('❌ CP4 & SECURITY VERIFICATION FAILED:', err);
  process.exit(1);
});
