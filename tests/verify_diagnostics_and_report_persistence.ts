import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  DiagnosticReporter,
  extractAiTelemetry,
  redactSensitiveText,
} from './lib/diagnosticReporter.ts';

async function runTests() {
  console.log('========================================================================');
  console.log('CLIPGENIUS AI — DIAGNOSTICS & INCREMENTAL REPORT PERSISTENCE TESTS');
  console.log('========================================================================\n');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clipgenius-diag-test-'));
  const reportPath = path.join(tmpRoot, 'test_report.json');
  const archiveDir = path.join(tmpRoot, 'archive');
  let passed = 0;
  let total = 0;

  function check(name: string, fn: () => void) {
    total++;
    try {
      fn();
      passed++;
      console.log(`[PASS] ${total}. ${name}`);
    } catch (err) {
      console.error(`[FAIL] ${total}. ${name}:`, (err as Error).message);
      throw err;
    }
  }

  try {
    // ------------------------------------------------------------------
    // 1. Immediate per-test logging + incremental disk writes + telemetry
    // ------------------------------------------------------------------
    const logs: string[] = [];
    const reporter = new DiagnosticReporter({
      reportPath,
      archiveDir,
      preservePreviousReport: true,
      logger: (line) => logs.push(line),
    });
    reporter.initialize();

    check('Report file is created immediately upon initialize()', () => {
      assert(fs.existsSync(reportPath), 'Report file should exist on disk immediately');
      const doc = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      assert.strictEqual(doc.runStatus, 'running');
    });

    reporter.startTest('test_alpha_analyze', { editorialStyle: 'educational' });

    check('startTest logs immediately and persists incomplete test status before completion', () => {
      assert(logs.some((l) => l.includes('[TEST START]') && l.includes('test_alpha_analyze')));
      const doc = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      assert.strictEqual(doc.tests.test_alpha_analyze.status, 'incomplete');
      assert(typeof doc.tests.test_alpha_analyze.startedAt === 'string');
    });

    const sampleResponse = {
      requestId: 'ai-srv-123',
      providerUsed: 'nemotron',
      modelUsed: 'nvidia/nemotron-3.5-super-vl:free',
      fallbackUsed: false,
      openRouterDetails: {
        requestId: 'gen-or-999',
        httpStatus: 200,
        latencyMs: 42150,
        networkRetryCount: 1,
        repairRetryCount: 0,
        finishReason: 'stop',
        promptTokens: 4100,
        completionTokens: 2500,
        reasoningTokens: 1800,
        totalTokens: 6600,
        cost: 0,
      },
    };

    const telemetry = extractAiTelemetry(200, sampleResponse, 45120);
    reporter.passTest('test_alpha_analyze', { telemetry, details: { clipsCount: 3 } });

    check('passTest records complete AI provider telemetry & logs completion immediately', () => {
      const doc = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const rec = doc.tests.test_alpha_analyze;
      assert.strictEqual(rec.status, 'passed');
      assert(typeof rec.elapsedMs === 'number' && rec.elapsedMs >= 0);
      assert.strictEqual(rec.telemetry.providerUsed, 'nemotron');
      assert.strictEqual(rec.telemetry.modelUsed, 'nvidia/nemotron-3.5-super-vl:free');
      assert.strictEqual(rec.telemetry.httpStatus, 200);
      assert.strictEqual(rec.telemetry.openRouterHttpStatus, 200);
      assert.strictEqual(rec.telemetry.latencyMs, 42150);
      assert.strictEqual(rec.telemetry.clientElapsedMs, 45120);
      assert.strictEqual(rec.telemetry.networkRetryCount, 1);
      assert.strictEqual(rec.telemetry.repairRetryCount, 0);
      assert.strictEqual(rec.telemetry.finishReason, 'stop');
      assert.strictEqual(rec.telemetry.fallbackUsed, false);
      assert.strictEqual(rec.telemetry.openRouterRequestId, 'gen-or-999');
      assert.deepStrictEqual(rec.telemetry.tokenUsage, {
        promptTokens: 4100,
        completionTokens: 2500,
        reasoningTokens: 1800,
        totalTokens: 6600,
      });
      assert.strictEqual(rec.telemetry.cost, 0);
      assert(logs.some((l) => l.includes('[TEST PASS]') && l.includes('gen-or-999')));
    });

    // ------------------------------------------------------------------
    // 2. Redaction of API keys, Authorization headers, and private video content
    // ------------------------------------------------------------------
    reporter.startTest('test_beta_redaction');
    reporter.setMetadata('headers', {
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature_secret_part',
      'x-api-key': 'sk-or-v1-abc1234567890abcdef',
    });
    reporter.failTest(
      'test_beta_redaction',
      new Error('Failed calling upstream with key sk-or-v1-secretkey999999 and AIzaSyDummyPrivateGeminiKey12345 and Bearer top_secret_bearer_tok'),
      {
        details: {
          rawTranscript: 'CONFIDENTIAL_PRIVATE_SPOKEN_VIDEO_CONTENT_DO_NOT_LOG',
          transcriptSegment: 'SECRET_CLIP_QUOTE_DO_NOT_EXPOSE',
          rawResponse: 'PRIVATE_RAW_RESPONSE_DO_NOT_EXPOSE',
          framePreview: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAA==',
          authorization: 'Bearer my-secret-header-value',
          safeMetric: 'ok',
        },
      }
    );

    check('Diagnostic logs and persisted JSON redact API keys, auth headers, and private video content', () => {
      const rawDisk = fs.readFileSync(reportPath, 'utf8');
      const joinedLogs = logs.join('\n');
      for (const secret of [
        'sk-or-v1-secretkey999999',
        'sk-or-v1-abc1234567890abcdef',
        'AIzaSyDummyPrivateGeminiKey12345',
        'top_secret_bearer_tok',
        'my-secret-header-value',
        'eyJhbGciOiJIUzI1NiJ9',
        'CONFIDENTIAL_PRIVATE_SPOKEN_VIDEO_CONTENT_DO_NOT_LOG',
        'SECRET_CLIP_QUOTE_DO_NOT_EXPOSE',
        'PRIVATE_RAW_RESPONSE_DO_NOT_EXPOSE',
        '/9j/4AAQSkZJRgABAQEASABIAAD',
      ]) {
        assert(!rawDisk.includes(secret), `Persisted JSON leaked sensitive value: ${secret}`);
        assert(!joinedLogs.includes(secret), `Console diagnostic log leaked sensitive value: ${secret}`);
      }
      const doc = JSON.parse(rawDisk);
      assert.strictEqual(doc.tests.test_beta_redaction.status, 'failed');
      assert.strictEqual(doc.tests.test_beta_redaction.details.safeMetric, 'ok');
    });

    // ------------------------------------------------------------------
    // 3. Preserving previous reports before overwriting
    // ------------------------------------------------------------------
    const previousDocBeforeRun2 = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const reporter2 = new DiagnosticReporter({
      reportPath,
      archiveDir,
      preservePreviousReport: true,
      logger: () => {},
    });
    const archivedPath = reporter2.initialize();

    check('Initializing a new run archives previous report without overwriting it', () => {
      assert(archivedPath && fs.existsSync(archivedPath), 'Archived previous report must exist');
      const archivedDoc = JSON.parse(fs.readFileSync(archivedPath, 'utf8'));
      assert.strictEqual(archivedDoc.runId, previousDocBeforeRun2.runId);
      assert.strictEqual(archivedDoc.tests.test_alpha_analyze.status, 'passed');
      const newDoc = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      assert.notStrictEqual(newDoc.runId, archivedDoc.runId);
      assert.strictEqual(newDoc.archivedPreviousReportPath, archivedPath);
    });

    // ------------------------------------------------------------------
    // 4. Real process crash & SIGTERM interruption handling
    // ------------------------------------------------------------------
    const crashReportPath = path.join(tmpRoot, 'crash_report.json');
    const crashArchiveDir = path.join(tmpRoot, 'crash_archive');
    const childScriptSigkill = path.join(tmpRoot, 'child_sigkill.ts');
    const reporterImportPath = path.resolve('tests/lib/diagnosticReporter.ts');

    fs.writeFileSync(
      childScriptSigkill,
      `import { DiagnosticReporter } from ${JSON.stringify(reporterImportPath)};
const r = new DiagnosticReporter({ reportPath: ${JSON.stringify(crashReportPath)}, archiveDir: ${JSON.stringify(crashArchiveDir)}, logger: () => {} });
r.initialize();
r.startTest('completed_before_crash');
r.passTest('completed_before_crash', { details: { ok: true } });
r.startTest('crashed_mid_execution');
process.kill(process.pid, 'SIGKILL');
`,
      'utf8'
    );

    let sigkillExited = false;
    try {
      execFileSync('npx', ['tsx', childScriptSigkill], { stdio: 'pipe' });
    } catch {
      sigkillExited = true;
    }

    check('Hard crash (SIGKILL) preserves prior completed tests and records interrupted test as incomplete', () => {
      assert(sigkillExited, 'Child process should terminate via SIGKILL');
      assert(fs.existsSync(crashReportPath), 'Crash report must exist on disk');
      const doc = JSON.parse(fs.readFileSync(crashReportPath, 'utf8'));
      assert.strictEqual(doc.tests.completed_before_crash.status, 'passed');
      assert.strictEqual(doc.tests.crashed_mid_execution.status, 'incomplete');
      assert.notStrictEqual(doc.tests.crashed_mid_execution.status, 'passed');
      assert.strictEqual(doc.summary.passed, 1);
      assert.strictEqual(doc.summary.incomplete, 1);
    });

    const sigtermReportPath = path.join(tmpRoot, 'sigterm_report.json');
    const childScriptSigterm = path.join(tmpRoot, 'child_sigterm.ts');
    fs.writeFileSync(
      childScriptSigterm,
      `import { DiagnosticReporter } from ${JSON.stringify(reporterImportPath)};
const r = new DiagnosticReporter({ reportPath: ${JSON.stringify(sigtermReportPath)}, archiveDir: ${JSON.stringify(crashArchiveDir)}, installSignalHandlers: true, logger: () => {} });
r.initialize();
r.startTest('step_one');
r.passTest('step_one');
r.startTest('step_two_interrupted');
process.kill(process.pid, 'SIGTERM');
setTimeout(() => {}, 5000);
`,
      'utf8'
    );

    let sigtermExitCode: number | null = null;
    try {
      execFileSync('npx', ['tsx', childScriptSigterm], { stdio: 'pipe' });
    } catch (err: any) {
      sigtermExitCode = err.status ?? null;
    }

    check('SIGTERM handler marks interrupted test incomplete with interruption reason and preserves prior results', () => {
      assert.strictEqual(sigtermExitCode, 130);
      const doc = JSON.parse(fs.readFileSync(sigtermReportPath, 'utf8'));
      assert.strictEqual(doc.runStatus, 'interrupted');
      assert(String(doc.interruptedReason).includes('SIGTERM'));
      assert.strictEqual(doc.tests.step_one.status, 'passed');
      assert.strictEqual(doc.tests.step_two_interrupted.status, 'incomplete');
      assert(String(doc.tests.step_two_interrupted.error).includes('Interrupted before completion'));
    });

    // ------------------------------------------------------------------
    // 5. Direct redactSensitiveText helper coverage
    // ------------------------------------------------------------------
    check('redactSensitiveText scrubs URL credentials and Supabase secret keys', () => {
      const cleaned = redactSensitiveText(
        'https://user:supersecretpass@db.example.com/postgres token=sb_secret_xyz123456789'
      );
      assert(!cleaned.includes('supersecretpass'));
      assert(!cleaned.includes('sb_secret_xyz123456789'));
    });

    console.log(`\n✓ ALL DIAGNOSTIC & PERSISTENCE TESTS PASSED: ${passed}/${total}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('\n❌ DIAGNOSTIC TEST SUITE FAILED:', err);
  process.exit(1);
});
