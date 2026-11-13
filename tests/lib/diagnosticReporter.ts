import fs from 'fs';
import path from 'path';

export type DiagnosticTestStatus = 'incomplete' | 'passed' | 'failed' | 'skipped';

export interface AiProviderTelemetry {
  providerUsed: string | null;
  modelUsed: string | null;
  httpStatus: number | null;
  openRouterHttpStatus: number | null;
  latencyMs: number | null;
  clientElapsedMs: number | null;
  networkRetryCount: number;
  repairRetryCount: number;
  finishReason: string | null;
  fallbackUsed: boolean | null;
  openRouterRequestId: string | null;
  serverRequestId: string | null;
  tokenUsage: {
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
  } | null;
  cost: number | null;
}

export interface DiagnosticTestRecord {
  name: string;
  status: DiagnosticTestStatus;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  error: string | null;
  telemetry: AiProviderTelemetry | null;
  details?: Record<string, unknown>;
}

export interface DiagnosticRunSummary {
  total: number;
  passed: number;
  failed: number;
  incomplete: number;
  skipped: number;
}

export interface DiagnosticReportDocument {
  reportVersion: string;
  runId: string;
  runStatus: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedPreviousReportPath: string | null;
  interruptedReason: string | null;
  metadata: Record<string, unknown>;
  summary: DiagnosticRunSummary;
  tests: Record<string, DiagnosticTestRecord>;
}

const SENSITIVE_KEY_PATTERN =
  /^(authorization|x-api-key|api[_-]?key|openrouter[_-]?api[_-]?key|gemini[_-]?api[_-]?key|supabase[_-]?(secret|service)[_-]?key|secret|password|passcode|cookie|token|access[_-]?token|refresh[_-]?token)$/i;

const PRIVATE_CONTENT_KEY_PATTERN =
  /^(rawTranscript|transcriptSegment|exact_quote|transcript|rawResponse|base64|videoContent)$/i;

export function redactSensitiveText(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/sk-or-v1-[A-Za-z0-9_-]{10,}/gi, '[REDACTED_OPENROUTER_KEY]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_GEMINI_KEY]')
    .replace(/sb_secret_[A-Za-z0-9_\-]{10,}/g, '[REDACTED_SUPABASE_KEY]')
    .replace(/sb_publishable_[A-Za-z0-9_\-]{10,}/g, '[REDACTED_SUPABASE_KEY]')
    .replace(/eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, '[REDACTED_JWT]')
    .replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]{16,}/g, 'data:image/[REDACTED_BASE64]')
    .replace(/(https?:\/\/[^:\s/@]+):([^@\s/]+)@/gi, '$1:[REDACTED]@');
}

export function sanitizeForDiagnostics<T>(value: T, keyHint: string = ''): T {
  if (value === null || value === undefined) return value;

  if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) {
    return '[REDACTED]' as unknown as T;
  }

  if (keyHint && PRIVATE_CONTENT_KEY_PATTERN.test(keyHint)) {
    const strLen = typeof value === 'string' ? value.length : JSON.stringify(value).length;
    return `[REDACTED_PRIVATE_CONTENT len=${strLen}]` as unknown as T;
  }

  if (typeof value === 'string') {
    return redactSensitiveText(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDiagnostics(item)) as unknown as T;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeForDiagnostics(v, k);
    }
    return out as T;
  }

  return value;
}

export function extractAiTelemetry(
  httpStatus: number | null,
  responseData: any,
  clientElapsedMs: number | null
): AiProviderTelemetry {
  const details = responseData?.openRouterDetails;
  const hasTokens =
    details &&
    (details.promptTokens !== undefined ||
      details.completionTokens !== undefined ||
      details.reasoningTokens !== undefined ||
      details.totalTokens !== undefined);

  return {
    providerUsed: responseData?.providerUsed ?? responseData?.audit?.actualProvider ?? null,
    modelUsed: responseData?.modelUsed ?? details?.model ?? responseData?.audit?.actualModel ?? null,
    httpStatus: httpStatus ?? null,
    openRouterHttpStatus: details?.httpStatus ?? null,
    latencyMs: details?.latencyMs ?? clientElapsedMs ?? null,
    clientElapsedMs: clientElapsedMs ?? null,
    networkRetryCount: details?.networkRetryCount ?? responseData?.audit?.networkRetryCount ?? 0,
    repairRetryCount: details?.repairRetryCount ?? responseData?.audit?.repairRetryCount ?? 0,
    finishReason: details?.finishReason ?? null,
    fallbackUsed: typeof responseData?.fallbackUsed === 'boolean' ? responseData.fallbackUsed : null,
    openRouterRequestId: details?.requestId ? redactSensitiveText(String(details.requestId)) : null,
    serverRequestId: responseData?.requestId ? redactSensitiveText(String(responseData.requestId)) : null,
    tokenUsage: hasTokens
      ? {
          promptTokens: details.promptTokens ?? null,
          completionTokens: details.completionTokens ?? null,
          reasoningTokens: details.reasoningTokens ?? null,
          totalTokens: details.totalTokens ?? null,
        }
      : null,
    cost: details?.cost ?? null,
  };
}

export interface DiagnosticReporterOptions {
  reportPath: string;
  archiveDir?: string;
  preservePreviousReport?: boolean;
  installSignalHandlers?: boolean;
  logger?: (line: string) => void;
}

export class DiagnosticReporter {
  private readonly reportPath: string;
  private readonly archiveDir: string;
  private readonly preservePreviousReport: boolean;
  private readonly logFn: (line: string) => void;
  private readonly activeStartTimes = new Map<string, number>();
  private archivedPreviousReportPath: string | null = null;
  private finalized = false;
  private signalHandlersInstalled = false;
  private readonly doc: DiagnosticReportDocument;

  constructor(options: DiagnosticReporterOptions) {
    this.reportPath = path.resolve(options.reportPath);
    this.archiveDir = path.resolve(
      options.archiveDir || path.join(path.dirname(this.reportPath), 'reports', 'archive')
    );
    this.preservePreviousReport = options.preservePreviousReport !== false;
    this.logFn = options.logger || ((line: string) => console.log(line));

    const now = new Date().toISOString();
    this.doc = {
      reportVersion: '2.0',
      runId: `run-${Date.now()}-${Math.round(Math.random() * 10000)}`,
      runStatus: 'running',
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      archivedPreviousReportPath: null,
      interruptedReason: null,
      metadata: {},
      summary: { total: 0, passed: 0, failed: 0, incomplete: 0, skipped: 0 },
      tests: {},
    };

    if (options.installSignalHandlers) {
      this.installSignalHandlers();
    }
  }

  public initialize(): string | null {
    fs.mkdirSync(path.dirname(this.reportPath), { recursive: true });

    if (this.preservePreviousReport && fs.existsSync(this.reportPath)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
      const ext = path.extname(this.reportPath) || '.json';
      const base = path.basename(this.reportPath, ext);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      let archivePath = path.join(this.archiveDir, `${base}.${stamp}${ext}`);
      let seq = 1;
      while (fs.existsSync(archivePath)) {
        archivePath = path.join(this.archiveDir, `${base}.${stamp}.${seq}${ext}`);
        seq++;
      }
      fs.copyFileSync(this.reportPath, archivePath);
      this.archivedPreviousReportPath = archivePath;
      this.doc.archivedPreviousReportPath = archivePath;
      this.logFn(`[Diagnostics] Preserved previous report at ${archivePath}`);
    }

    this.flush();
    return this.archivedPreviousReportPath;
  }

  public setMetadata(key: string, value: unknown): void {
    this.doc.metadata[key] = sanitizeForDiagnostics(value, key);
    this.flush();
  }

  public startTest(name: string, details?: Record<string, unknown>): void {
    const startedAt = new Date().toISOString();
    this.activeStartTimes.set(name, Date.now());
    this.doc.tests[name] = {
      name,
      status: 'incomplete',
      startedAt,
      completedAt: null,
      elapsedMs: null,
      error: null,
      telemetry: null,
      details: details ? sanitizeForDiagnostics(details) : undefined,
    };
    this.logFn(`[TEST START] [${startedAt}] ${name}`);
    this.flush();
  }

  public passTest(
    name: string,
    options?: {
      telemetry?: AiProviderTelemetry | null;
      details?: Record<string, unknown>;
    }
  ): DiagnosticTestRecord {
    const completedAt = new Date().toISOString();
    const startMs = this.activeStartTimes.get(name);
    const elapsedMs = startMs !== undefined ? Date.now() - startMs : null;
    this.activeStartTimes.delete(name);

    const existing = this.doc.tests[name];
    const record: DiagnosticTestRecord = {
      name,
      status: 'passed',
      startedAt: existing?.startedAt || completedAt,
      completedAt,
      elapsedMs,
      error: null,
      telemetry: options?.telemetry ? sanitizeForDiagnostics(options.telemetry) : null,
      details: options?.details
        ? sanitizeForDiagnostics(options.details)
        : existing?.details,
    };

    this.doc.tests[name] = record;
    this.logFn(
      `[TEST PASS]  [${completedAt}] ${name} | status=passed | elapsedMs=${elapsedMs ?? 'n/a'}${formatTelemetrySuffix(record.telemetry)}`
    );
    this.flush();
    return record;
  }

  public failTest(
    name: string,
    error: unknown,
    options?: {
      telemetry?: AiProviderTelemetry | null;
      details?: Record<string, unknown>;
    }
  ): DiagnosticTestRecord {
    const completedAt = new Date().toISOString();
    const startMs = this.activeStartTimes.get(name);
    const elapsedMs = startMs !== undefined ? Date.now() - startMs : null;
    this.activeStartTimes.delete(name);

    const rawErr = error instanceof Error ? error.message : String(error);
    const safeErr = redactSensitiveText(rawErr);
    const existing = this.doc.tests[name];

    const record: DiagnosticTestRecord = {
      name,
      status: 'failed',
      startedAt: existing?.startedAt || completedAt,
      completedAt,
      elapsedMs,
      error: safeErr,
      telemetry: options?.telemetry ? sanitizeForDiagnostics(options.telemetry) : null,
      details: options?.details
        ? sanitizeForDiagnostics(options.details)
        : existing?.details,
    };

    this.doc.tests[name] = record;
    this.logFn(
      `[TEST FAIL]  [${completedAt}] ${name} | status=failed | elapsedMs=${elapsedMs ?? 'n/a'} | error=${safeErr}${formatTelemetrySuffix(record.telemetry)}`
    );
    this.flush();
    return record;
  }

  public markSkipped(name: string, reason: string): DiagnosticTestRecord {
    const now = new Date().toISOString();
    const record: DiagnosticTestRecord = {
      name,
      status: 'skipped',
      startedAt: now,
      completedAt: now,
      elapsedMs: 0,
      error: redactSensitiveText(reason),
      telemetry: null,
    };
    this.doc.tests[name] = record;
    this.logFn(`[TEST SKIP]  [${now}] ${name} | reason=${record.error}`);
    this.flush();
    return record;
  }

  public markInterrupted(reason: string): DiagnosticReportDocument {
    const now = new Date().toISOString();
    const safeReason = redactSensitiveText(reason);
    this.doc.runStatus = 'interrupted';
    this.doc.interruptedReason = safeReason;
    this.doc.completedAt = now;

    for (const [name, test] of Object.entries(this.doc.tests)) {
      if (test.status === 'incomplete') {
        const startMs = this.activeStartTimes.get(name);
        test.completedAt = now;
        test.elapsedMs = startMs !== undefined ? Date.now() - startMs : test.elapsedMs;
        test.error = test.error || `Interrupted before completion: ${safeReason}`;
        this.activeStartTimes.delete(name);
      }
    }

    this.logFn(`[RUN INTERRUPTED] [${now}] reason=${safeReason}`);
    this.flush();
    this.finalized = true;
    return this.getSnapshot();
  }

  public finalize(status?: 'completed' | 'failed'): DiagnosticReportDocument {
    const now = new Date().toISOString();
    this.recomputeSummary();

    for (const [name, test] of Object.entries(this.doc.tests)) {
      if (test.status === 'incomplete') {
        const startMs = this.activeStartTimes.get(name);
        test.completedAt = test.completedAt || now;
        test.elapsedMs = test.elapsedMs ?? (startMs !== undefined ? Date.now() - startMs : null);
        test.error = test.error || 'Test did not complete cleanly (marked incomplete).';
        this.activeStartTimes.delete(name);
      }
    }

    this.recomputeSummary();
    if (!this.finalized) {
      this.doc.runStatus =
        status || (this.doc.summary.failed > 0 || this.doc.summary.incomplete > 0 ? 'failed' : 'completed');
      this.doc.completedAt = now;
      this.finalized = true;
    }

    this.flush();
    return this.getSnapshot();
  }

  public getSnapshot(): DiagnosticReportDocument {
    this.recomputeSummary();
    return JSON.parse(JSON.stringify(this.doc));
  }

  public getReportPath(): string {
    return this.reportPath;
  }

  private recomputeSummary(): void {
    const records = Object.values(this.doc.tests);
    const summary: DiagnosticRunSummary = {
      total: records.length,
      passed: 0,
      failed: 0,
      incomplete: 0,
      skipped: 0,
    };
    for (const rec of records) {
      if (rec.status === 'passed') summary.passed++;
      else if (rec.status === 'failed') summary.failed++;
      else if (rec.status === 'skipped') summary.skipped++;
      else summary.incomplete++;
    }
    this.doc.summary = summary;
  }

  private flush(): void {
    this.recomputeSummary();
    this.doc.updatedAt = new Date().toISOString();
    const tmpPath = `${this.reportPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.doc, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.reportPath);
  }

  private installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;

    const handleInterrupt = (sig: string) => {
      try {
        this.markInterrupted(`Process received ${sig}`);
      } catch {
        // best effort
      }
      process.exit(130);
    };

    process.once('SIGINT', () => handleInterrupt('SIGINT'));
    process.once('SIGTERM', () => handleInterrupt('SIGTERM'));
  }
}

function formatTelemetrySuffix(telemetry: AiProviderTelemetry | null): string {
  if (!telemetry) return '';
  const tokens = telemetry.tokenUsage
    ? `${telemetry.tokenUsage.promptTokens ?? 0}/${telemetry.tokenUsage.completionTokens ?? 0}/${telemetry.tokenUsage.reasoningTokens ?? 0}`
    : 'n/a';
  const costStr = telemetry.cost !== null && telemetry.cost !== undefined ? `$${telemetry.cost.toFixed(4)}` : 'n/a';
  return (
    ` | provider=${telemetry.providerUsed} | model=${telemetry.modelUsed}` +
    ` | http=${telemetry.httpStatus} (openrouter=${telemetry.openRouterHttpStatus})` +
    ` | latencyMs=${telemetry.latencyMs} | netRetries=${telemetry.networkRetryCount}` +
    ` | repairRetries=${telemetry.repairRetryCount} | finish=${telemetry.finishReason}` +
    ` | fallback=${telemetry.fallbackUsed} | orReqId=${telemetry.openRouterRequestId}` +
    ` | tokens(P/C/R)=${tokens} | cost=${costStr}`
  );
}
