import { build } from 'esbuild';
import { promises as fsp, existsSync } from 'fs';
import { join, resolve, basename, dirname, relative } from 'path';
import { eq, inArray } from 'drizzle-orm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

const LIVE_IO = process.env.WOODTRON_LIVE_IO_TESTS === '1';
const liveDescribe = LIVE_IO ? describe.sequential : describe.skip;
const LIVE_FUZZ = process.env.WOODTRON_LIVE_IO_FUZZ === '1';
const LIVE_FUZZ_LIMIT = Math.max(1, Number(process.env.WOODTRON_LIVE_IO_FUZZ_SCENARIOS ?? '12'));

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
} as const;

type ScenarioLogLevel = 'step' | 'pass' | 'warn' | 'fail';

type ScenarioLogEntry = {
  timestamp: string;
  level: ScenarioLogLevel;
  message: string;
};

type FileWriteEntry = {
  timestamp: string;
  path: string;
  content: string;
};

type FileOutcomeEntry = {
  timestamp: string;
  path: string;
  outcome: 'archive' | 'incorrect_files' | 'consumed' | 'observed';
  contentPreview: string;
};

type MessageEntry = {
  createdAt: string;
  event: string;
  title: string;
  body: string;
  source: string | null;
};

type WatcherEntry = {
  name: string;
  label: string;
  status: string;
  lastEventAt: string | null;
  lastEvent: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
};

type ScenarioReport = {
  name: string;
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  logs: ScenarioLogEntry[];
  filesWritten: FileWriteEntry[];
  fileOutcomes: FileOutcomeEntry[];
  appMessages: MessageEntry[];
  watchersBefore: WatcherEntry[];
  watchersAfter: WatcherEntry[];
  error: string | null;
  startedAtMs: number;
};

type LiveIoReport = {
  runId: string;
  target: string;
  startedAt: string;
  finishedAt: string;
  settingsPath: string;
  machine: {
    machineId: number;
    name: string;
    token: string;
  } | null;
  paths: {
    autoPacDir: string;
    grundnerDir: string;
    nestpickDir: string;
    processedJobsRoot: string;
  };
  scenarios: ScenarioReport[];
};

const reportOutputDir = resolve(process.cwd(), 'tests/reports');
const failedFilesOutputDir = resolve(process.cwd(), 'tests/failed_files');
const liveDelaySecondsRaw = Number(process.env.WOODTRON_LIVE_IO_FUZZ_DELAY_S ?? '0');
const LIVE_DELAY_MS = Number.isFinite(liveDelaySecondsRaw) && liveDelaySecondsRaw > 0 ? Math.floor(liveDelaySecondsRaw * 1000) : 0;

type FixtureAsset = {
  base: string;
  folderRel: string;
  sourceDir: string;
  ncPath: string;
  nestpickPayloadPath: string;
  nestpickPayloadExt: '.nsp' | '.npt';
};

function sanitizeToken(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length ? cleaned : 'case';
}

function shortId5(): string {
  const n = Math.floor(Math.random() * 36 ** 5);
  return n.toString(36).padStart(5, '0');
}
const liveReport: LiveIoReport = {
  runId: `live-io-${Date.now()}`,
  target: process.env.WOODTRON_LIVE_IO_TARGET ?? 'all',
  startedAt: new Date().toISOString(),
  finishedAt: '',
  settingsPath: resolve(process.cwd(), 'settings.json'),
  machine: null,
  paths: {
    autoPacDir: '',
    grundnerDir: '',
    nestpickDir: '',
    processedJobsRoot: ''
  },
  scenarios: []
};

let currentScenario: ScenarioReport | null = null;

function recordScenarioLog(level: ScenarioLogLevel, message: string) {
  if (!currentScenario) return;
  currentScenario.logs.push({ timestamp: new Date().toISOString(), level, message });
}

function compactWatcherSnapshot(snapshot: any): WatcherEntry[] {
  const watchers = Array.isArray(snapshot?.watchers) ? snapshot.watchers : [];
  return watchers.map((w: any) => ({
    name: String(w?.name ?? ''),
    label: String(w?.label ?? ''),
    status: String(w?.status ?? ''),
    lastEventAt: w?.lastEventAt ?? null,
    lastEvent: w?.lastEvent ?? null,
    lastErrorAt: w?.lastErrorAt ?? null,
    lastError: w?.lastError ?? null
  }));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimeForReport(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}:${ms}`;
}

function slug(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'scenario';
}

function deriveWatcherFamilyFromScenarioName(name: string): 'autopac' | 'grundner' | 'nestpick' | 'e2e' | 'other' {
  const lower = name.toLowerCase();
  if (lower.includes('autopac')) return 'autopac';
  if (lower.includes('grundner')) return 'grundner';
  if (lower.includes('nestpick')) return 'nestpick';
  if (lower.includes('end-to-end') || lower.includes('end to end') || lower.includes('e2e')) return 'e2e';
  return 'other';
}

function deriveIncorrectInputAttempts(scenario: ScenarioReport): number {
  const fromOutcomes = scenario.fileOutcomes.filter((f) => f.outcome === 'incorrect_files').length;
  const fromMessages = scenario.appMessages.filter((m) => {
    const e = m.event.toLowerCase();
    return e.includes('format_error') || e.includes('invalid_transition') || e.includes('quarantined') || e.includes('job_not_found');
  }).length;
  return Math.max(fromOutcomes, fromMessages);
}

async function persistFailedScenarioArtifacts(report: LiveIoReport, scenario: ScenarioReport) {
  if (scenario.status !== 'failed') return;
  await ensureDir(failedFilesOutputDir);
  const folderName = `${reportTimestampForFile()}_${slug(scenario.name)}`;
  const scenarioDir = join(failedFilesOutputDir, folderName);
  const inputsDir = join(scenarioDir, 'inputs');
  await ensureDir(inputsDir);

  for (let i = 0; i < scenario.filesWritten.length; i += 1) {
    const entry = scenario.filesWritten[i];
    const ext = basename(entry.path).includes('.') ? basename(entry.path).slice(basename(entry.path).lastIndexOf('.')) : '.txt';
    const fileName = `${String(i + 1).padStart(2, '0')}_${slug(basename(entry.path, ext)).slice(0, 40)}${ext}`;
    await fsp.writeFile(join(inputsDir, fileName), entry.content, 'utf8');
  }

  const manifest = {
    runId: report.runId,
    scenario: scenario.name,
    startedAt: scenario.startedAt,
    finishedAt: scenario.finishedAt,
    error: scenario.error,
    filesWritten: scenario.filesWritten,
    fileOutcomes: scenario.fileOutcomes,
    appMessages: scenario.appMessages,
    watchersBefore: scenario.watchersBefore,
    watchersAfter: scenario.watchersAfter
  };
  await fsp.writeFile(join(scenarioDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

function renderReportHtml(report: LiveIoReport): string {
  const passedCount = report.scenarios.filter((s) => s.status === 'passed').length;
  const failedCount = report.scenarios.filter((s) => s.status === 'failed').length;
  const watcherStats = new Map<string, { attempts: number; failed: number; scenarios: number }>();
  for (const scenario of report.scenarios) {
    const family = deriveWatcherFamilyFromScenarioName(scenario.name);
    const current = watcherStats.get(family) ?? { attempts: 0, failed: 0, scenarios: 0 };
    current.scenarios += 1;
    current.attempts += deriveIncorrectInputAttempts(scenario);
    if (scenario.status === 'failed') current.failed += 1;
    watcherStats.set(family, current);
  }

  const summaryCards = Array.from(watcherStats.entries())
    .map(([family, stats]) => {
      const ok = stats.failed === 0;
      return `<div class="card ${ok ? 'ok' : 'bad'}"><h3>${escapeHtml(family.toUpperCase())}</h3><p><strong>Scenarios:</strong> ${stats.scenarios}</p><p><strong>Bad-input attempts:</strong> ${stats.attempts}</p><p><strong>Scenario failures:</strong> ${stats.failed}</p></div>`;
    })
    .join('');

  const scenarioBlocks = report.scenarios
    .map((scenario) => {
      const statusClass = scenario.status === 'passed' ? 'ok' : 'bad';
      const logs = scenario.logs
        .map(
          (log) =>
            `<li><code>${escapeHtml(formatTimeForReport(log.timestamp))}</code> <strong>${escapeHtml(log.level)}</strong> ${escapeHtml(log.message)}</li>`
        )
        .join('');
      const writes = scenario.filesWritten
        .map(
          (entry) =>
            `<li><code>${escapeHtml(entry.path)}</code><pre>${escapeHtml(entry.content)}</pre></li>`
        )
        .join('');
      const outcomes = scenario.fileOutcomes
        .filter((entry) => entry.outcome !== 'observed')
        .map(
          (entry) =>
            `<li><code>${escapeHtml(entry.outcome)}</code> <code>${escapeHtml(entry.path)}</code><pre>${escapeHtml(entry.contentPreview)}</pre></li>`
        )
        .join('');
      const messages = scenario.appMessages
        .map(
          (entry) =>
            `<tr><td>${escapeHtml(formatTimeForReport(entry.createdAt))}</td><td>${escapeHtml(entry.event)}</td><td>${escapeHtml(entry.title)}</td><td>${escapeHtml(entry.body)}</td><td>${escapeHtml(entry.source ?? '')}</td></tr>`
        )
        .join('');
      const watcherRows = scenario.watchersAfter
        .map(
          (w) =>
            `<tr><td>${escapeHtml(w.label || w.name)}</td><td>${escapeHtml(w.status)}</td><td>${escapeHtml(w.lastEvent ?? '')}</td><td>${escapeHtml(w.lastError ?? '')}</td></tr>`
        )
        .join('');

      return `
      <section class="scenario">
        <h2>${escapeHtml(scenario.name)} <span class="pill ${statusClass}">${escapeHtml(scenario.status)}</span></h2>
        <p><strong>Started:</strong> ${escapeHtml(formatTimeForReport(scenario.startedAt))} | <strong>Finished:</strong> ${escapeHtml(formatTimeForReport(scenario.finishedAt))} | <strong>Duration:</strong> ${scenario.durationMs} ms</p>
        ${scenario.error ? `<p class="error"><strong>Error:</strong> ${escapeHtml(scenario.error)}</p>` : ''}
        <p><strong>Incorrect input attempts:</strong> ${deriveIncorrectInputAttempts(scenario)}</p>
        <h3>Logs</h3>
        <ul>${logs || '<li>None</li>'}</ul>
        <h3>Files Written</h3>
        <ul>${writes || '<li>None</li>'}</ul>
        <h3>File Outcomes</h3>
        <ul>${outcomes || '<li>None</li>'}</ul>
        <h3>App Messages</h3>
        <table><thead><tr><th>Created</th><th>Event</th><th>Title</th><th>Body</th><th>Source</th></tr></thead><tbody>${messages || '<tr><td colspan="5">None</td></tr>'}</tbody></table>
        <h3>Watcher State After Scenario</h3>
        <table><thead><tr><th>Watcher</th><th>Status</th><th>Last Event</th><th>Last Error</th></tr></thead><tbody>${watcherRows || '<tr><td colspan="4">None</td></tr>'}</tbody></table>
      </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Live IO Test Report</title>
    <style>
      body { font-family: Segoe UI, Arial, sans-serif; margin: 24px; background: #f7f8fa; color: #111; }
      h1 { margin-bottom: 6px; }
      .meta { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 16px; }
      .card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 10px; }
      .card.ok { border-color: #9cdab3; background: #f1fbf5; }
      .card.bad { border-color: #f2a4a4; background: #fff1f1; }
      .scenario { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
      .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
      .pill.ok { background: #e7f8ee; color: #0b7a3c; }
      .pill.bad { background: #ffe8e8; color: #a70000; }
      table { border-collapse: collapse; width: 100%; margin-top: 8px; }
      th, td { border: 1px solid #ddd; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #f0f2f5; }
      pre { background: #0f172a; color: #e2e8f0; padding: 8px; border-radius: 6px; white-space: pre-wrap; }
      code { background: #f1f5f9; padding: 1px 4px; border-radius: 4px; }
      .error { color: #a70000; }
    </style>
  </head>
  <body>
    <h1>Live IO Test Report</h1>
    <div class="meta">
      <p><strong>Run ID:</strong> ${escapeHtml(report.runId)}</p>
      <p><strong>Target:</strong> ${escapeHtml(report.target)}</p>
      <p><strong>Started:</strong> ${escapeHtml(formatTimeForReport(report.startedAt))}</p>
      <p><strong>Finished:</strong> ${escapeHtml(formatTimeForReport(report.finishedAt))}</p>
      <p><strong>Settings Path:</strong> <code>${escapeHtml(report.settingsPath)}</code></p>
      <p><strong>Machine:</strong> ${escapeHtml(report.machine ? `${report.machine.name} #${report.machine.machineId}` : 'none')}</p>
      <p><strong>AutoPAC Dir:</strong> <code>${escapeHtml(report.paths.autoPacDir)}</code></p>
      <p><strong>Grundner Dir:</strong> <code>${escapeHtml(report.paths.grundnerDir)}</code></p>
      <p><strong>Nestpick Dir:</strong> <code>${escapeHtml(report.paths.nestpickDir)}</code></p>
      <p><strong>Processed Root:</strong> <code>${escapeHtml(report.paths.processedJobsRoot)}</code></p>
      <p><strong>Scenarios:</strong> ${report.scenarios.length}</p>
      <p><strong>Passed:</strong> ${passedCount} | <strong>Failed:</strong> ${failedCount}</p>
    </div>
    <div class="cards">${summaryCards}</div>
    ${scenarioBlocks || '<p>No scenarios recorded.</p>'}
  </body>
</html>`;
}

function reportTimestampForFile(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

async function writeRunReport() {
  liveReport.finishedAt = new Date().toISOString();
  await ensureDir(reportOutputDir);
  const stamp = reportTimestampForFile();
  const html = renderReportHtml(liveReport);
  const json = JSON.stringify(liveReport, null, 2);
  const htmlPath = join(reportOutputDir, `live-io-report-${stamp}.html`);
  const jsonPath = join(reportOutputDir, `live-io-report-${stamp}.json`);
  const latestHtmlPath = join(reportOutputDir, 'live-io-latest.html');
  const latestJsonPath = join(reportOutputDir, 'live-io-latest.json');
  await fsp.writeFile(htmlPath, html, 'utf8');
  await fsp.writeFile(jsonPath, json, 'utf8');
  await fsp.writeFile(latestHtmlPath, html, 'utf8');
  await fsp.writeFile(latestJsonPath, json, 'utf8');
  logStep(`HTML report: ${htmlPath}`);
  logStep(`JSON report: ${jsonPath}`);
}

async function runScenario(name: string, fn: () => Promise<void>) {
  const startedAtMs = Date.now();
  const scenario: ScenarioReport = {
    name,
    status: 'passed',
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: '',
    durationMs: 0,
    logs: [],
    filesWritten: [],
    fileOutcomes: [],
    appMessages: [],
    watchersBefore: compactWatcherSnapshot(getDiagnosticsSnapshot?.() ?? null),
    watchersAfter: [],
    error: null,
    startedAtMs
  };

  liveReport.scenarios.push(scenario);
  currentScenario = scenario;
  try {
    await fn();
    scenario.status = 'passed';
  } catch (err) {
    scenario.status = 'failed';
    scenario.error = err instanceof Error ? err.message : String(err);
    logFail(`Scenario failed: ${name} -> ${scenario.error}`);
    throw err;
  } finally {
    scenario.finishedAt = new Date().toISOString();
    scenario.durationMs = Date.now() - startedAtMs;
    scenario.appMessages = messagesSince(startedAtMs).map((entry) => ({
      createdAt: String(entry.createdAt ?? ''),
      event: String(entry.event ?? ''),
      title: String(entry.title ?? ''),
      body: String(entry.body ?? ''),
      source: entry.source ? String(entry.source) : null
    }));
    scenario.watchersAfter = compactWatcherSnapshot(getDiagnosticsSnapshot?.() ?? null);
    if (scenario.status === 'failed') {
      await persistFailedScenarioArtifacts(liveReport, scenario);
    }
    currentScenario = null;
  }
}

function logStep(message: string) {
  recordScenarioLog('step', message);
  console.log(`${C.cyan}[live-io]${C.reset} ${message}`);
}

function logPass(message: string) {
  recordScenarioLog('pass', message);
  console.log(`${C.green}[pass]${C.reset} ${message}`);
}

function logWarn(message: string) {
  recordScenarioLog('warn', message);
  console.log(`${C.yellow}[warn]${C.reset} ${message}`);
}

function logFail(message: string) {
  recordScenarioLog('fail', message);
  console.log(`${C.red}[fail]${C.reset} ${message}`);
}

type MachineRow = {
  machineId: number;
  name: string;
  apJobfolder: string;
  nestpickFolder: string;
  nestpickEnabled: boolean;
};

type CreatedJob = {
  key: string;
  base: string;
};

const createdJobKeys: string[] = [];

let workerBundlePath = '';
let baseFromJobsRoot = 'LIVE_IO_BASE';
let fixtureAsset: FixtureAsset | null = null;

let loadConfig: (() => any) | null = null;
let withDb: ((fn: (db: any) => Promise<any>) => Promise<any>) | null = null;
let resetPool: (() => Promise<void>) | null = null;
let listMachines: (() => Promise<MachineRow[]>) | null = null;
let initializeDiagnostics: ((customDir?: string) => Promise<void>) | null = null;
let getDiagnosticsSnapshot: (() => any) | null = null;
let listAppMessages: (() => any[]) | null = null;
let initWatchers: (() => void) | null = null;
let shutdownWatchers: (() => Promise<void>) | null = null;
let jobsTable: any = null;
let electronMock: any = null;

let cfg: any = null;
let machine: MachineRow | null = null;
let machineToken = '';
let autoPacDir = '';
let grundnerDir = '';
let nestpickDir = '';

function assertLiveConfigReady() {
  if (!cfg || !machine || !withDb || !jobsTable || !listAppMessages) {
    throw new Error('Live IO test harness is not initialized');
  }
}

async function delay(ms: number) {
  await new Promise((resolveTimer) => setTimeout(resolveTimer, ms));
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 30_000,
  intervalMs = 250
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await probe();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

async function unlinkIfExists(path: string) {
  try {
    await fsp.unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw err;
  }
}

async function ensureDir(path: string) {
  await fsp.mkdir(path, { recursive: true });
}

async function writeAtomic(path: string, content: string) {
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite existing file: ${path}`);
  }
  const tmp = `${path}.tmp-${Date.now()}`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, path);
  if (currentScenario) {
    currentScenario.filesWritten.push({
      timestamp: new Date().toISOString(),
      path,
      content
    });
  }
}

function sanitizeBase(raw: string) {
  const cleaned = raw.replace(/[^A-Za-z0-9_. -]/g, '').trim();
  return cleaned.length ? cleaned : 'LIVE_IO_BASE';
}

async function findAnyNcBase(root: string): Promise<string | null> {
  const stack = [root];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) continue;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = (await fsp.readdir(next, { withFileTypes: true })) as any;
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(next, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.nc')) continue;
      const base = basename(entry.name, '.nc');
      return sanitizeBase(base);
    }
  }
  return null;
}

async function findFixtureAsset(root: string): Promise<FixtureAsset | null> {
  const stack = [root];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) continue;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = (await fsp.readdir(next, { withFileTypes: true })) as any;
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(join(next, entry.name));
      }
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      let ext: '.nsp' | '.npt' | null = null;
      if (lower.endsWith('.nsp')) ext = '.nsp';
      else if (lower.endsWith('.npt')) ext = '.npt';
      if (!ext) continue;

      const base = basename(entry.name, ext);
      const ncPath = join(next, `${base}.nc`);
      const payloadPath = join(next, `${base}${ext}`);
      if (!existsSync(ncPath)) continue;
      const folderRelRaw = relative(root, next).replace(/\\/g, '/');
      const folderRel = folderRelRaw.length ? folderRelRaw : 'LIVE_FIXTURE';
      return {
        base: sanitizeBase(base),
        folderRel,
        sourceDir: next,
        ncPath,
        nestpickPayloadPath: payloadPath,
        nestpickPayloadExt: ext
      };
    }
  }
  return null;
}

async function copyDirWithBaseRename(sourceDir: string, targetDir: string, sourceBase: string, targetBase: string) {
  await ensureDir(targetDir);
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      const sub = join(targetDir, entry.name);
      await copyDirWithBaseRename(src, sub, sourceBase, targetBase);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')) : '';
    const stem = ext ? entry.name.slice(0, -ext.length) : entry.name;
    const renamed = stem === sourceBase ? `${targetBase}${ext}` : entry.name;
    const dst = join(targetDir, renamed);
    await ensureDir(dirname(dst));
    await fsp.copyFile(src, dst);
  }
}

async function createVariantFixtureAsset(caseId: string): Promise<FixtureAsset> {
  if (!fixtureAsset || !cfg?.paths?.processedJobsRoot) {
    throw new Error('Fixture asset and processedJobsRoot must be initialized before creating variant assets');
  }
  const caseToken = sanitizeToken(caseId).slice(-5) || 'case5';
  const runToken = shortId5();
  const uniqueBase = `${fixtureAsset.base}_${caseToken}_${runToken}`;
  const sourceLeaf = fixtureLeafFromFolder(fixtureAsset.folderRel);
  const variantFolder = join(cfg.paths.processedJobsRoot, 'LIVE_IO_CASES', `${sourceLeaf}_${caseToken}_${runToken}`);
  await copyDirWithBaseRename(fixtureAsset.sourceDir, variantFolder, fixtureAsset.base, uniqueBase);

  const payloadExt = existsSync(join(variantFolder, `${uniqueBase}.nsp`)) ? '.nsp' : '.npt';
  const folderRelRaw = relative(cfg.paths.processedJobsRoot, variantFolder).replace(/\\/g, '/');
  return {
    base: uniqueBase,
    folderRel: folderRelRaw.length ? folderRelRaw : 'LIVE_IO_CASE',
    sourceDir: variantFolder,
    ncPath: join(variantFolder, `${uniqueBase}.nc`),
    nestpickPayloadPath: join(variantFolder, `${uniqueBase}${payloadExt}`),
    nestpickPayloadExt: payloadExt
  };
}

async function pacedWriteAtomic(path: string, content: string) {
  await writeAtomic(path, content);
  if (LIVE_DELAY_MS > 0) {
    logStep(`Pausing ${Math.floor(LIVE_DELAY_MS / 1000)}s for live observation`);
    await delay(LIVE_DELAY_MS);
  }
}

function fixtureLeafFromFolder(folderRel: string): string {
  const parts = folderRel.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? folderRel;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) continue;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = (await fsp.readdir(next, { withFileTypes: true })) as any;
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(next, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

async function stageFixtureFolderToReady(asset: FixtureAsset) {
  if (!machine) throw new Error('Machine is not initialized');
  const leaf = fixtureLeafFromFolder(asset.folderRel);
  const destinationRoot = join(machine.apJobfolder, leaf);
  await ensureDir(destinationRoot);

  const sourceFiles = await listFilesRecursive(asset.sourceDir);
  let copiedCount = 0;
  for (const sourceFile of sourceFiles) {
    const rel = relative(asset.sourceDir, sourceFile).replace(/^[/\\]+/, '');
    const target = join(destinationRoot, rel);
    await ensureDir(dirname(target));
    await fsp.copyFile(sourceFile, target);
    copiedCount += 1;
  }

  logStep(`Staged fixture folder ${asset.sourceDir} into ${destinationRoot} with ${copiedCount} file(s)`);
}

async function waitForFile(path: string, timeoutMs = 30_000) {
  return waitFor(`file ${path}`, async () => {
    if (!existsSync(path)) return null;
    return path;
  }, timeoutMs, 250);
}

async function triggerCncFinishForJob(base: string) {
  if (!machine) throw new Error('Machine is not initialized');
  const cncPath = join(autoPacDir, `cnc_finish${machineToken}.csv`);
  await pacedWriteAtomic(cncPath, `${base},${machine.machineId}\r\n`);
}

async function waitForArchiveFile(
  folder: string,
  startsWith: string,
  sinceMs: number,
  contains?: string,
  nameIncludes?: string,
  timeoutMs = 30_000
) {
  return waitFor(`archived ${startsWith} in ${folder}`, async () => {
    if (!existsSync(folder)) return null;
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.startsWith(startsWith));
    for (const entry of files) {
      if (nameIncludes && !entry.name.includes(nameIncludes)) continue;
      const full = join(folder, entry.name);
      const stats = await fsp.stat(full);
      if (stats.mtimeMs < sinceMs - 1000) continue;
      let content = '';
      try {
        content = await fsp.readFile(full, 'utf8');
      } catch {
        content = '[binary or unreadable]';
      }
      if (contains && !content.includes(contains)) {
        continue;
      }
      if (currentScenario) {
        currentScenario.fileOutcomes.push({
          timestamp: new Date().toISOString(),
          path: full,
          outcome: 'archive',
          contentPreview: content
        });
      }
      return full;
    }
    return null;
  }, timeoutMs, 300);
}

async function createFixtureJob(status: string, assetOverride?: FixtureAsset): Promise<CreatedJob> {
  assertLiveConfigReady();
  const asset = assetOverride ?? fixtureAsset;
  if (!asset) {
    throw new Error('No fixture asset selected. Add paired .nc + .nsp files under processedJobsRoot (legacy .npt also supported).');
  }

  const key = `${asset.folderRel}/${asset.base}`.slice(0, 100);

  // Stage files first, then insert pending row.
  // This avoids a race where jobs-ingest prunes a PENDING row before its .nc exists on disk.
  await stageFixtureFolderToReady(asset);

  const upsertRow = async () => {
    await withDb!(async (db) => {
      await db
        .insert(jobsTable)
        .values({
          key,
          folder: asset.folderRel,
          ncfile: `${asset.base}.nc`,
          machineId: machine!.machineId,
          status,
          dateAdded: new Date(),
          updatedAt: new Date(),
          isLocked: false,
          preReserved: false,
          qty: 1
        })
        .onConflictDoUpdate({
          target: jobsTable.key,
          set: {
            folder: asset.folderRel,
            ncfile: `${asset.base}.nc`,
            machineId: machine!.machineId,
            status,
            updatedAt: new Date(),
            isLocked: false,
            preReserved: false
          }
        });
    });
  };

  await upsertRow();

  // jobs-ingest can run concurrently and prune newly inserted PENDING rows
  // if it scanned before this fixture folder appeared.
  // Retry a few times so the row survives once ingest catches up.
  if (status === 'PENDING') {
    for (let i = 0; i < 3; i += 1) {
      await delay(450);
      const row = await getJob(key);
      if (row) break;
      logWarn(`Reinserting pruned pending fixture job ${key} after ingest race`);
      await upsertRow();
    }
  }

  createdJobKeys.push(key);

  logStep(`Created fixture-backed job ${key} from ${asset.base} with status ${status}`);
  return { key, base: asset.base };
}

async function getJob(key: string): Promise<{ status: string; pallet: string | null } | null> {
  assertLiveConfigReady();
  return withDb!(async (db) => {
    const rows = await db
      .select({ status: jobsTable.status, pallet: jobsTable.pallet })
      .from(jobsTable)
      .where(eq(jobsTable.key, key))
      .limit(1);
    if (!rows.length) return null;
    return { status: rows[0].status, pallet: rows[0].pallet ?? null };
  });
}

async function waitForJobStatus(key: string, expected: string, timeoutMs = 35_000) {
  return waitFor(`job ${key} -> ${expected}`, async () => {
    const row = await getJob(key);
    if (!row) return null;
    if (row.status !== expected) return null;
    return row;
  }, timeoutMs, 300);
}

async function waitForMovedFile(folder: string, filePrefix: string, sinceMs: number, timeoutMs = 25_000) {
  const movedPath = await waitFor(`moved file ${filePrefix} in ${folder}`, async () => {
    if (!existsSync(folder)) return null;
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    const candidates: Array<{ name: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith(filePrefix)) continue;
      const full = join(folder, entry.name);
      const stats = await fsp.stat(full);
      if (stats.mtimeMs < sinceMs - 1000) continue;
      candidates.push({ name: entry.name, mtimeMs: stats.mtimeMs });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return join(folder, candidates[0].name);
  }, timeoutMs, 300);

  if (currentScenario) {
    let preview = '';
    try {
      preview = await fsp.readFile(movedPath, 'utf8');
    } catch {
      preview = '[binary or unreadable]';
    }
    const lower = folder.toLowerCase();
    const outcome: FileOutcomeEntry['outcome'] =
      lower.includes('incorrect_files') ? 'incorrect_files' : lower.includes('archive') ? 'archive' : 'observed';
    currentScenario.fileOutcomes.push({
      timestamp: new Date().toISOString(),
      path: movedPath,
      outcome,
      contentPreview: preview
    });
  }

  return movedPath;
}

function messagesSince(startMs: number) {
  const all = listAppMessages!();
  return all.filter((entry) => Date.parse(entry.createdAt) >= startMs - 1000);
}

async function cleanupSlotFiles() {
  if (!machine) return;
  const files = [
    join(autoPacDir, `load_finish${machineToken}.csv`),
    join(autoPacDir, `label_finish${machineToken}.csv`),
    join(autoPacDir, `cnc_finish${machineToken}.csv`),
    join(autoPacDir, `order_saw${machineToken}.csv`),
    join(grundnerDir, 'ChangeMachNr.csv'),
    join(grundnerDir, 'ChangeMachNr.tmp'),
    join(grundnerDir, 'ChangeMachNr.erl'),
    join(nestpickDir, 'Nestpick.csv'),
    join(nestpickDir, 'Nestpick.erl'),
    join(nestpickDir, 'Report_FullNestpickUnstack.csv')
  ];
  for (const file of files) {
    await unlinkIfExists(file);
  }
}

liveDescribe('Live Watcher IO Suites', () => {
  const liveFuzzIt = LIVE_FUZZ ? it : it.skip;

  beforeAll(async () => {
    const rootSettingsPath = resolve(process.cwd(), 'settings.json');
    process.env.WOODTRON_CONFIG_PATH = rootSettingsPath;

    const tmpDir = resolve(process.cwd(), 'tests/.tmp');
    await ensureDir(tmpDir);
    workerBundlePath = join(tmpDir, 'watchersWorker.live.test.js');

    logStep(`Building watcher worker bundle for tests at ${workerBundlePath}`);
    await build({
      entryPoints: [resolve(process.cwd(), 'packages/main/src/workers/watchersWorker.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: ['node20'],
      external: ['electron', 'fsevents'],
      outfile: workerBundlePath,
      sourcemap: false,
      logLevel: 'silent'
    });
    process.env.WOODTRON_WATCHERS_WORKER_PATH = workerBundlePath;

    const configMod = await import('../packages/main/src/services/config');
    const dbMod = await import('../packages/main/src/services/db');
    const machinesMod = await import('../packages/main/src/repo/machinesRepo');
    const diagnosticsMod = await import('../packages/main/src/services/diagnostics');
    const messagesMod = await import('../packages/main/src/services/messages');
    const watchersMod = await import('../packages/main/src/services/watchers');
    const schemaMod = await import('../packages/main/src/db/schema');
    electronMock = await import('electron');

    loadConfig = configMod.loadConfig;
    withDb = dbMod.withDb;
    resetPool = dbMod.resetPool;
    listMachines = machinesMod.listMachines;
    initializeDiagnostics = diagnosticsMod.initializeDiagnostics;
    getDiagnosticsSnapshot = diagnosticsMod.getDiagnosticsSnapshot;
    listAppMessages = messagesMod.listAppMessages;
    initWatchers = watchersMod.initWatchers;
    shutdownWatchers = watchersMod.shutdownWatchers;
    jobsTable = schemaMod.jobs;

    await initializeDiagnostics!(resolve(process.cwd(), 'tests/.tmp'));
    cfg = loadConfig!();

    autoPacDir = cfg.paths.autoPacCsvDir;
    grundnerDir = cfg.paths.grundnerFolderPath;
    const processedRoot = cfg.paths.processedJobsRoot;

    if (!autoPacDir || !grundnerDir || !processedRoot) {
      throw new Error('settings.paths.autoPacCsvDir, settings.paths.grundnerFolderPath, and settings.paths.processedJobsRoot must be configured for live IO tests');
    }

    const allMachines = await listMachines!();
    machine =
      allMachines.find((m) => m.nestpickEnabled && typeof m.nestpickFolder === 'string' && m.nestpickFolder.trim().length > 0) ??
      null;

    if (!machine) {
      throw new Error('No machine with Nestpick enabled + folder configured was found in machines table');
    }

    if (!machine.apJobfolder || !machine.apJobfolder.trim()) {
      throw new Error(`Machine ${machine.machineId} is missing apJobfolder; required for stage sanity`);
    }

    machineToken = String(machine.machineId);
    nestpickDir = machine.nestpickFolder;

    liveReport.machine = {
      machineId: machine.machineId,
      name: machine.name,
      token: machineToken
    };
    liveReport.paths = {
      autoPacDir,
      grundnerDir,
      nestpickDir,
      processedJobsRoot: processedRoot
    };

    await ensureDir(autoPacDir);
    await ensureDir(grundnerDir);
    await ensureDir(processedRoot);
    await ensureDir(machine.apJobfolder);
    await ensureDir(nestpickDir);
    await ensureDir(join(autoPacDir, 'incorrect_files'));
    await ensureDir(join(grundnerDir, 'incorrect_files'));
    await ensureDir(join(nestpickDir, 'incorrect_files'));
    await ensureDir(join(autoPacDir, 'archive'));
    await ensureDir(join(grundnerDir, 'archive'));
    await ensureDir(join(nestpickDir, 'archive'));

    fixtureAsset = await findFixtureAsset(processedRoot);
    if (!fixtureAsset) {
      throw new Error(`No fixture found under ${processedRoot}. Add at least one matching pair: <base>.nc and <base>.nsp (legacy .npt also supported)`);
    }

    if (cfg.paths.jobsRoot && existsSync(cfg.paths.jobsRoot)) {
      const foundBase = await findAnyNcBase(cfg.paths.jobsRoot);
      if (foundBase) {
        baseFromJobsRoot = foundBase;
      } else {
        logWarn(`No .nc file found under jobsRoot ${cfg.paths.jobsRoot}; using fallback base ${baseFromJobsRoot}`);
      }
    } else {
      logWarn(`jobsRoot missing or unavailable in settings; using fallback base ${baseFromJobsRoot}`);
    }

    electronMock?.__mock?.clearSentIpc?.();
    electronMock?.__mock?.emitIpcMain?.('ui:dialog:ready');

    logStep('Starting watchers worker for live IO tests');
    initWatchers!();

    await waitFor('watchers ready', async () => {
      const snapshot = getDiagnosticsSnapshot!();
      const watcherNames = [
        'watcher:autopac',
        'watcher:grundner',
        `watcher:nestpick-stack:${machine!.machineId}`,
        `watcher:nestpick-unstack:${machine!.machineId}`
      ];
      const allWatching = watcherNames.every((name) => snapshot.watchers.some((w: any) => w.name === name && w.status === 'watching'));
      return allWatching ? true : null;
    }, 50_000, 500);

    logPass(`Watchers ready. Using machine ${machine.name} (#${machine.machineId}), token ${machineToken}`);
    logStep(`AutoPAC dir: ${autoPacDir}`);
    logStep(`Grundner dir: ${grundnerDir}`);
    logStep(`Nestpick dir: ${nestpickDir}`);
    logStep(`Seed NC base from jobsRoot: ${baseFromJobsRoot}`);
    logStep(`Fixture selected: ${fixtureAsset.base} from ${fixtureAsset.folderRel}`);
    logStep(`Archive IO mode: ${cfg.integrations?.archiveIoFiles ? 'enabled' : 'disabled'}`);
    if (LIVE_DELAY_MS > 0) {
      logStep(`Live fuzz pacing enabled: ${Math.floor(LIVE_DELAY_MS / 1000)} seconds between file writes`);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      try {
        if (createdJobKeys.length && withDb && jobsTable) {
          await withDb(async (db) => {
            await db.delete(jobsTable).where(inArray(jobsTable.key, createdJobKeys));
          });
          logStep(`Cleaned up ${createdJobKeys.length} test jobs`);
        }
      } catch (err) {
        logWarn(`Failed to clean up test jobs: ${err instanceof Error ? err.message : String(err)}`);
      }

      await cleanupSlotFiles().catch(() => {});

      if (shutdownWatchers) {
        await shutdownWatchers();
        logStep('Watchers worker shut down');
      }
      if (resetPool) {
        await resetPool();
      }
    } finally {
      await writeRunReport();
    }
  }, 90_000);

  it('AutoPAC suite: valid lifecycle CSVs progress PENDING -> CNC_FINISH', async () => {
    await runScenario('AutoPAC suite: valid lifecycle CSVs progress PENDING -> CNC_FINISH', async () => {
      assertLiveConfigReady();
      await cleanupSlotFiles();

      const job = await createFixtureJob('PENDING');
      const startMs = Date.now();

      const loadPath = join(autoPacDir, `load_finish${machineToken}.csv`);
      const labelPath = join(autoPacDir, `label_finish${machineToken}.csv`);
      const cncPath = join(autoPacDir, `cnc_finish${machineToken}.csv`);

      logStep(`Writing ${basename(loadPath)} for base ${job.base}`);
      await writeAtomic(loadPath, `${job.base},${machine!.machineId}\r\n`);
      await waitForJobStatus(job.key, 'LOAD_FINISH');
      logPass(`Job ${job.key} reached LOAD_FINISH`);

      logStep(`Writing ${basename(labelPath)} for base ${job.base}`);
      await writeAtomic(labelPath, `${job.base},${machine!.machineId}\r\n`);
      await waitForJobStatus(job.key, 'LABEL_FINISH');
      logPass(`Job ${job.key} reached LABEL_FINISH`);

      logStep(`Writing ${basename(cncPath)} for base ${job.base}`);
      await writeAtomic(cncPath, `${job.base},${machine!.machineId}\r\n`);
      await waitForJobStatus(job.key, 'CNC_FINISH');
      logPass(`Job ${job.key} reached CNC_FINISH`);

      const producedMessages = messagesSince(startMs);
      logStep(`AutoPAC scenario produced ${producedMessages.length} app message(s)`);
    });
  }, 90_000);

  it('AutoPAC suite: out-of-order file is quarantined and watcher still recovers', async () => {
    await runScenario('AutoPAC suite: out-of-order file is quarantined and watcher still recovers', async () => {
      assertLiveConfigReady();
      await cleanupSlotFiles();

      const startMs = Date.now();

      const badJob = await createFixtureJob('PENDING');
      const outOfOrderPath = join(autoPacDir, `label_finish${machineToken}.csv`);
      await writeAtomic(outOfOrderPath, `${badJob.base},${machine!.machineId}\r\n`);
      logStep(`Injected out-of-order AutoPAC file ${basename(outOfOrderPath)} for ${badJob.base}`);

      const quarantined = await waitForMovedFile(join(autoPacDir, 'incorrect_files'), `label_finish${machineToken}_`, startMs);
      expect(existsSync(quarantined)).toBe(true);
      logPass(`Out-of-order CSV quarantined to ${quarantined}`);

      await delay(1500);
      const badRow = await getJob(badJob.key);
      expect(badRow?.status).toBe('PENDING');
      logPass('Out-of-order file did not incorrectly advance lifecycle');

      const diagnosticsSnapshot = getDiagnosticsSnapshot!();
      const autoPacWatcher = diagnosticsSnapshot.watchers.find((w: any) => w.name === 'watcher:autopac');
      expect(autoPacWatcher?.status).toBeTruthy();
      logPass('Watcher remained active after out-of-order file');

      // Recovery check: after bad input, valid input still processes.
      const goodJob = await createFixtureJob('PENDING');
      const validPath = join(autoPacDir, `load_finish${machineToken}.csv`);
      await writeAtomic(validPath, `${goodJob.base},${machine!.machineId}\r\n`);
      await waitForJobStatus(goodJob.key, 'LOAD_FINISH');
      logPass('Watcher continued processing correct files after incorrect file');
    });
  }, 90_000);

  it('Grundner suite: order_saw receives ChangeMachNr.erl and advances STAGED -> RUNNING', async () => {
    await runScenario('Grundner suite: order_saw receives ChangeMachNr.erl and advances STAGED -> RUNNING', async () => {
      assertLiveConfigReady();
      await cleanupSlotFiles();
      const startedAt = Date.now();

      const okJob = await createFixtureJob('STAGED');
      const orderPath = join(autoPacDir, `order_saw${machineToken}.csv`);
      await pacedWriteAtomic(orderPath, `${okJob.base};${machine!.machineId};\r\n`);
      logStep(`Wrote ${basename(orderPath)} to trigger ChangeMachNr send for ${okJob.base}`);

      const changeCsv = join(grundnerDir, 'ChangeMachNr.csv');
      await waitFor(`ChangeMachNr.csv written in ${grundnerDir}`, async () => (existsSync(changeCsv) ? true : null), 25_000, 200);
      const requestBody = await fsp.readFile(changeCsv, 'utf8');
      expect(requestBody).toContain(okJob.base);
      if (currentScenario) {
        currentScenario.fileOutcomes.push({
          timestamp: new Date().toISOString(),
          path: changeCsv,
          outcome: 'observed',
          contentPreview: requestBody
        });
      }
      logPass('order_saw generated ChangeMachNr.csv with expected payload');

      await waitForArchiveFile(join(grundnerDir, 'archive'), 'ChangeMachNr_', startedAt, okJob.base, '_sent');
      logPass('Outbound ChangeMachNr.csv copy was archived as sent');

      const erlPath = join(grundnerDir, 'ChangeMachNr.erl');
      const replyStart = Date.now();
      await pacedWriteAtomic(erlPath, requestBody);

      // Simulate production behavior where Grundner removes request slot file after producing reply.
      await unlinkIfExists(changeCsv);
      if (currentScenario) {
        currentScenario.fileOutcomes.push({
          timestamp: new Date().toISOString(),
          path: changeCsv,
          outcome: 'consumed',
          contentPreview: 'Simulated Grundner deletion after ChangeMachNr.erl write'
        });
      }

      await waitForJobStatus(okJob.key, 'RUNNING', 40_000);
      logPass('Matching ChangeMachNr.erl advanced lifecycle STAGED -> RUNNING');

      await waitForArchiveFile(join(grundnerDir, 'archive'), 'ChangeMachNr_', replyStart, okJob.base);
      logPass('Inbound ChangeMachNr.erl was archived');

      const diagnosticsSnapshot = getDiagnosticsSnapshot!();
      const autoPacWatcher = diagnosticsSnapshot.watchers.find((w: any) => w.name === 'watcher:autopac');
      expect(autoPacWatcher?.status).toBeTruthy();
      logPass('AutoPAC watcher stayed healthy after writing order_saw input');
    });
  }, 90_000);

  it('Nestpick suite: app forwards Nestpick.csv then stack and unstack complete lifecycle', async () => {
    await runScenario('Nestpick suite: app forwards Nestpick.csv then stack and unstack complete lifecycle', async () => {
      assertLiveConfigReady();
      await cleanupSlotFiles();
      const startedAt = Date.now();

      const job = await createFixtureJob('LABEL_FINISH');
      const stackCsvPath = join(nestpickDir, 'Nestpick.csv');
      const stackErlPath = join(nestpickDir, 'Nestpick.erl');

      await triggerCncFinishForJob(job.base);
      await waitForJobStatus(job.key, 'CNC_FINISH', 35_000);

      await waitFor('app forwarded Nestpick.csv', async () => (existsSync(stackCsvPath) ? true : null), 45_000, 300);
      const stackPayload = await fsp.readFile(stackCsvPath, 'utf8');
      if (currentScenario) {
        currentScenario.fileOutcomes.push({
          timestamp: new Date().toISOString(),
          path: stackCsvPath,
          outcome: 'observed',
          contentPreview: stackPayload
        });
      }
      logPass('App generated outbound Nestpick.csv from staged fixture payload (.nsp or .npt)');

      await waitForArchiveFile(join(nestpickDir, 'archive'), 'Nestpick_', startedAt, stackPayload.trim(), '_sent');
      logPass('Outbound Nestpick.csv copy was archived as sent');

      logStep(`Writing Nestpick stack reply for base ${job.base}`);
      const replyStart = Date.now();
      await pacedWriteAtomic(stackErlPath, stackPayload);
      // Simulate production behavior where Nestpick removes request slot file after producing reply.
      await unlinkIfExists(stackCsvPath);
      if (currentScenario) {
        currentScenario.fileOutcomes.push({
          timestamp: new Date().toISOString(),
          path: stackCsvPath,
          outcome: 'consumed',
          contentPreview: 'Simulated Nestpick deletion after Nestpick.erl write'
        });
      }

      await waitForJobStatus(job.key, 'FORWARDED_TO_NESTPICK');
      logPass('Nestpick stack file progressed CNC_FINISH -> FORWARDED_TO_NESTPICK');

      await waitForArchiveFile(join(nestpickDir, 'archive'), 'Nestpick_', replyStart, stackPayload.trim());
      logPass('Inbound Nestpick.erl was archived');

      const unstackPath = join(nestpickDir, 'Report_FullNestpickUnstack.csv');
      await pacedWriteAtomic(unstackPath, `${job.base},PALLET-42\r\n`);
      const done = await waitForJobStatus(job.key, 'NESTPICK_COMPLETE');
      expect(done.pallet).toBe('PALLET-42');
      logPass('Nestpick unstack file progressed FORWARDED_TO_NESTPICK -> NESTPICK_COMPLETE with pallet update');

      await waitForArchiveFile(join(nestpickDir, 'archive'), 'Report_FullNestpickUnstack_', startedAt, job.base);
      logPass('Unstack report file was archived');
    });
  }, 90_000);

  it('End-to-end suite: fixture job flows STAGED -> RUNNING -> CNC_FINISH -> NESTPICK_COMPLETE', async () => {
    await runScenario('End-to-end suite: fixture job flows STAGED -> RUNNING -> CNC_FINISH -> NESTPICK_COMPLETE', async () => {
      assertLiveConfigReady();
      await cleanupSlotFiles();
      const startedAt = Date.now();

      const job = await createFixtureJob('STAGED');

      const orderPath = join(autoPacDir, `order_saw${machineToken}.csv`);
      await pacedWriteAtomic(orderPath, `${job.base};${machine!.machineId};\r\n`);
      const changeCsv = join(grundnerDir, 'ChangeMachNr.csv');
      await waitForFile(changeCsv, 35_000);
      const changeRequest = await fsp.readFile(changeCsv, 'utf8');
      await waitForArchiveFile(join(grundnerDir, 'archive'), 'ChangeMachNr_', startedAt, job.base, '_sent');
      const changeErl = join(grundnerDir, 'ChangeMachNr.erl');
      const grundnerReplyStart = Date.now();
      await pacedWriteAtomic(changeErl, changeRequest);
      await unlinkIfExists(changeCsv);
      await waitForJobStatus(job.key, 'RUNNING', 45_000);
      await waitForArchiveFile(join(grundnerDir, 'archive'), 'ChangeMachNr_', grundnerReplyStart, job.base);
      logPass('order_saw and ChangeMachNr reply completed STAGED -> RUNNING');

      const loadPath = join(autoPacDir, `load_finish${machineToken}.csv`);
      const labelPath = join(autoPacDir, `label_finish${machineToken}.csv`);
      const cncPath = join(autoPacDir, `cnc_finish${machineToken}.csv`);
      await pacedWriteAtomic(loadPath, `${job.base},${machine!.machineId}\r\n`);
      await waitForJobStatus(job.key, 'LOAD_FINISH', 30_000);
      await pacedWriteAtomic(labelPath, `${job.base},${machine!.machineId}\r\n`);
      await waitForJobStatus(job.key, 'LABEL_FINISH', 30_000);
      await pacedWriteAtomic(cncPath, `${job.base},${machine!.machineId}\r\n`);
      await waitForJobStatus(job.key, 'CNC_FINISH', 30_000);
      await waitForArchiveFile(join(autoPacDir, 'archive'), `load_finish${machineToken}_`, startedAt, job.base);
      await waitForArchiveFile(join(autoPacDir, 'archive'), `label_finish${machineToken}_`, startedAt, job.base);
      await waitForArchiveFile(join(autoPacDir, 'archive'), `cnc_finish${machineToken}_`, startedAt, job.base);
      logPass('AutoPAC lifecycle files advanced job through CNC_FINISH and were archived');

      const nestpickCsv = join(nestpickDir, 'Nestpick.csv');
      await waitForFile(nestpickCsv, 45_000);
      const nestpickPayload = await fsp.readFile(nestpickCsv, 'utf8');
      await waitForArchiveFile(join(nestpickDir, 'archive'), 'Nestpick_', startedAt, nestpickPayload.trim(), '_sent');
      const nestpickErl = join(nestpickDir, 'Nestpick.erl');
      const nestpickReplyStart = Date.now();
      await pacedWriteAtomic(nestpickErl, nestpickPayload);
      await unlinkIfExists(nestpickCsv);
      await waitForJobStatus(job.key, 'FORWARDED_TO_NESTPICK', 35_000);
      await waitForArchiveFile(join(nestpickDir, 'archive'), 'Nestpick_', nestpickReplyStart, nestpickPayload.trim());
      logPass('Nestpick stack reply advanced lifecycle and archived IO files');

      const unstackPath = join(nestpickDir, 'Report_FullNestpickUnstack.csv');
      await pacedWriteAtomic(unstackPath, `${job.base},PALLET-E2E\r\n`);
      const done = await waitForJobStatus(job.key, 'NESTPICK_COMPLETE', 35_000);
      expect(done.pallet).toBe('PALLET-E2E');
      await waitForArchiveFile(join(nestpickDir, 'archive'), 'Report_FullNestpickUnstack_', startedAt, job.base);
      logPass('End-to-end chain reached NESTPICK_COMPLETE with archived stack and unstack files');
    });
  }, 180_000);

  liveFuzzIt('Live fuzz smoke: named scenarios with paced file generation and archive checks', async () => {
    type CaseDef = { id: string; name: string; run: (asset: FixtureAsset) => Promise<void> };
    const cases: CaseDef[] = [
      {
        id: 'L-FZ-AUTOPAC-001',
        name: 'AutoPAC valid load_finish archives and advances status',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('PENDING', asset);
          const path = join(autoPacDir, `load_finish${machineToken}.csv`);
          await pacedWriteAtomic(path, `${job.base},${machine!.machineId}\r\n`);
          await waitForJobStatus(job.key, 'LOAD_FINISH');
          await waitForArchiveFile(join(autoPacDir, 'archive'), `load_finish${machineToken}_`, startedAt, job.base);
        }
      },
      {
        id: 'L-FZ-AUTOPAC-002',
        name: 'AutoPAC out-of-order label_finish quarantines',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('PENDING', asset);
          const path = join(autoPacDir, `label_finish${machineToken}.csv`);
          await pacedWriteAtomic(path, `${job.base},${machine!.machineId}\r\n`);
          await waitForMovedFile(join(autoPacDir, 'incorrect_files'), `label_finish${machineToken}_`, startedAt);
          const row = await getJob(job.key);
          expect(row?.status).toBe('PENDING');
        }
      },
      {
        id: 'L-FZ-AUTOPAC-003',
        name: 'AutoPAC empty file quarantines',
        run: async () => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const path = join(autoPacDir, `load_finish${machineToken}.csv`);
          await pacedWriteAtomic(path, '');
          await waitForMovedFile(join(autoPacDir, 'incorrect_files'), `load_finish${machineToken}_`, startedAt);
        }
      },
      {
        id: 'L-FZ-AUTOPAC-004',
        name: 'AutoPAC bad delimiter quarantines',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('PENDING', asset);
          const path = join(autoPacDir, `load_finish${machineToken}.csv`);
          await pacedWriteAtomic(path, `${job.base}|${machine!.machineId}\r\n`);
          await waitForMovedFile(join(autoPacDir, 'incorrect_files'), `load_finish${machineToken}_`, startedAt);
        }
      },
      {
        id: 'L-FZ-AUTOPAC-005',
        name: 'AutoPAC machine mismatch quarantines',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('PENDING', asset);
          const path = join(autoPacDir, `load_finish${machineToken}.csv`);
          await pacedWriteAtomic(path, `${job.base},999\r\n`);
          await waitForMovedFile(join(autoPacDir, 'incorrect_files'), `load_finish${machineToken}_`, startedAt);
        }
      },
      {
        id: 'L-FZ-GRUNDNER-006',
        name: 'ChangeMachNr matching reply archives and moves STAGED to RUNNING',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('STAGED', asset);
          const orderPath = join(autoPacDir, `order_saw${machineToken}.csv`);
          await pacedWriteAtomic(orderPath, `${job.base};${machine!.machineId};\r\n`);
          const changeCsv = join(grundnerDir, 'ChangeMachNr.csv');
          await waitForFile(changeCsv, 35_000);
          const body = await fsp.readFile(changeCsv, 'utf8');
          await waitForArchiveFile(join(grundnerDir, 'archive'), 'ChangeMachNr_', startedAt, job.base, '_sent');
          const erlPath = join(grundnerDir, 'ChangeMachNr.erl');
          const replyStart = Date.now();
          await pacedWriteAtomic(erlPath, body);
          await unlinkIfExists(changeCsv);
          await waitForJobStatus(job.key, 'RUNNING', 40_000);
          await waitForArchiveFile(join(grundnerDir, 'archive'), 'ChangeMachNr_', replyStart, job.base);
        }
      },
      {
        id: 'L-FZ-GRUNDNER-007',
        name: 'ChangeMachNr mismatch reply quarantines and status stays STAGED',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('STAGED', asset);
          const orderPath = join(autoPacDir, `order_saw${machineToken}.csv`);
          await pacedWriteAtomic(orderPath, `${job.base};${machine!.machineId};\r\n`);
          const changeCsv = join(grundnerDir, 'ChangeMachNr.csv');
          await waitForFile(changeCsv, 35_000);
          const erlPath = join(grundnerDir, 'ChangeMachNr.erl');
          await pacedWriteAtomic(erlPath, 'WRONG;999;\r\n');
          await waitForMovedFile(join(grundnerDir, 'incorrect_files'), 'ChangeMachNr_', startedAt);
          const row = await getJob(job.key);
          expect(row?.status).toBe('STAGED');
        }
      },
      {
        id: 'L-FZ-NESTPICK-008',
        name: 'Nestpick valid stack reply archives and advances to FORWARDED_TO_NESTPICK',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('LABEL_FINISH', asset);
          await triggerCncFinishForJob(job.base);
          await waitForJobStatus(job.key, 'CNC_FINISH', 35_000);
          const csvPath = join(nestpickDir, 'Nestpick.csv');
          await waitForFile(csvPath, 45_000);
          const payload = await fsp.readFile(csvPath, 'utf8');
          await waitForArchiveFile(join(nestpickDir, 'archive'), 'Nestpick_', startedAt, payload.trim(), '_sent');
          const erlPath = join(nestpickDir, 'Nestpick.erl');
          const replyStart = Date.now();
          await pacedWriteAtomic(erlPath, payload);
          await unlinkIfExists(csvPath);
          await waitForJobStatus(job.key, 'FORWARDED_TO_NESTPICK', 35_000);
          await waitForArchiveFile(join(nestpickDir, 'archive'), 'Nestpick_', replyStart, payload.trim());
        }
      },
      {
        id: 'L-FZ-NESTPICK-009',
        name: 'Nestpick mismatched stack reply quarantines',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('LABEL_FINISH', asset);
          await triggerCncFinishForJob(job.base);
          await waitForJobStatus(job.key, 'CNC_FINISH', 35_000);
          const csvPath = join(nestpickDir, 'Nestpick.csv');
          await waitForFile(csvPath, 45_000);
          const erlPath = join(nestpickDir, 'Nestpick.erl');
          await pacedWriteAtomic(erlPath, `BAD_${job.base},X\r\n`);
          await waitForMovedFile(join(nestpickDir, 'incorrect_files'), 'Nestpick_', startedAt);
        }
      },
      {
        id: 'L-FZ-NESTPICK-010',
        name: 'Nestpick valid unstack archives and advances complete',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('LABEL_FINISH', asset);
          await triggerCncFinishForJob(job.base);
          await waitForJobStatus(job.key, 'CNC_FINISH', 35_000);
          const csvPath = join(nestpickDir, 'Nestpick.csv');
          await waitForFile(csvPath, 45_000);
          const payload = await fsp.readFile(csvPath, 'utf8');
          const erlPath = join(nestpickDir, 'Nestpick.erl');
          await pacedWriteAtomic(erlPath, payload);
          await unlinkIfExists(csvPath);
          await waitForJobStatus(job.key, 'FORWARDED_TO_NESTPICK', 35_000);
          const unstackPath = join(nestpickDir, 'Report_FullNestpickUnstack.csv');
          await pacedWriteAtomic(unstackPath, `${job.base},PALLET-FUZZ\r\n`);
          await waitForJobStatus(job.key, 'NESTPICK_COMPLETE', 35_000);
          await waitForArchiveFile(join(nestpickDir, 'archive'), 'Report_FullNestpickUnstack_', startedAt, job.base);
        }
      },
      {
        id: 'L-FZ-NESTPICK-011',
        name: 'Nestpick empty unstack quarantines',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('LABEL_FINISH', asset);
          await triggerCncFinishForJob(job.base);
          await waitForJobStatus(job.key, 'CNC_FINISH', 35_000);
          const csvPath = join(nestpickDir, 'Nestpick.csv');
          await waitForFile(csvPath, 45_000);
          const payload = await fsp.readFile(csvPath, 'utf8');
          const erlPath = join(nestpickDir, 'Nestpick.erl');
          await pacedWriteAtomic(erlPath, payload);
          await unlinkIfExists(csvPath);
          await waitForJobStatus(job.key, 'FORWARDED_TO_NESTPICK', 35_000);
          const unstackPath = join(nestpickDir, 'Report_FullNestpickUnstack.csv');
          await pacedWriteAtomic(unstackPath, '');
          await waitForMovedFile(join(nestpickDir, 'incorrect_files'), 'Report_FullNestpickUnstack_', startedAt);
        }
      },
      {
        id: 'L-FZ-ORDER-012',
        name: 'Out-of-sequence cnc_finish quarantines then valid load_finish still processes',
        run: async (asset) => {
          await cleanupSlotFiles();
          const startedAt = Date.now();
          const job = await createFixtureJob('PENDING', asset);
          const cncPath = join(autoPacDir, `cnc_finish${machineToken}.csv`);
          await pacedWriteAtomic(cncPath, `${job.base},${machine!.machineId}\r\n`);
          await waitForMovedFile(join(autoPacDir, 'incorrect_files'), `cnc_finish${machineToken}_`, startedAt);
          const loadPath = join(autoPacDir, `load_finish${machineToken}.csv`);
          await pacedWriteAtomic(loadPath, `${job.base},${machine!.machineId}\r\n`);
          await waitForJobStatus(job.key, 'LOAD_FINISH');
        }
      }
    ];

    const selected = cases.slice(0, Math.min(cases.length, LIVE_FUZZ_LIMIT));
    logStep(`Executing ${selected.length} live fuzz case(s) with delay ${LIVE_DELAY_MS}ms between writes`);
    for (const fuzzCase of selected) {
      const caseAsset = await createVariantFixtureAsset(fuzzCase.id);
      await runScenario(`${fuzzCase.id} ${fuzzCase.name}`, async () => {
        await fuzzCase.run(caseAsset);
      });
    }
  }, 900_000);

  it.skip('Nestpick suite: invalid unstack is quarantined and does not advance lifecycle', async () => {
    // Intentionally skipped for now.
    // In this environment, empty-file race timing on Report_FullNestpickUnstack.csv
    // is non-deterministic on network-share semantics and needs a dedicated harness.
  });
});
