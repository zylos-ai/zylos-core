import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflightInputs } from './router-ready-auth.js';

export const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
export const CASES = ['normal', 'slow-hook', 'missing-session-id', 'late-launch', 'boundary-ready'];
export function failure(code) { return Object.assign(new Error(code), { code }); }
export function configFromEnv(env = process.env) {
  const integer = (name, fallback, min = 1) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min) throw failure('INVALID_MEASUREMENT_CONFIG');
    return value;
  };
  const runtimes = (env.READY_MEASURE_RUNTIMES || 'claude,codex').split(',');
  const cases = (env.READY_MEASURE_CASES || CASES.join(',')).split(',');
  if (!runtimes.length || runtimes.some(r => !['claude','codex'].includes(r)) || new Set(runtimes).size !== runtimes.length ||
      cases.some(c => !CASES.includes(c)) || new Set(cases).size !== cases.length) throw failure('INVALID_MEASUREMENT_CONFIG');
  const config = {
    runtimes, cases, coldCount: integer('READY_MEASURE_COLD_COUNT', 10, 0), repeatCount: integer('READY_MEASURE_REPEAT_COUNT', 10, 0),
    readyTimeoutMs: integer('READY_MEASURE_TIMEOUT_MS', 60000), observationMs: integer('READY_MEASURE_OBSERVATION_MS', 90000),
    pollMs: integer('READY_MEASURE_POLL_MS', 200), slowHookMs: integer('READY_MEASURE_SLOW_HOOK_MS', 2000),
    machineLabel: env.READY_MEASURE_MACHINE || null,
    evidenceDir: path.resolve(env.READY_MEASURE_EVIDENCE_DIR || 'ready-measure-evidence'),
    binaries: { claude: env.READY_MEASURE_CLAUDE_BIN || 'claude', codex: env.READY_MEASURE_CODEX_BIN || 'codex' },
  };
  if (config.observationMs <= config.readyTimeoutMs + Math.max(1000, 2 * config.pollMs) || config.slowHookMs >= config.observationMs) throw failure('INVALID_MEASUREMENT_CONFIG');
  return config;
}
export function measurementEnv(env = process.env) {
  const result = { PATH: env.PATH || '', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
  for (const key of [...PROXY_KEYS, 'TEST_TMUX_BIN', 'READY_MEASURE_CLAUDE_CREDENTIALS', 'READY_MEASURE_CODEX_API_KEY']) {
    if (env[key]) result[key] = env[key];
  }
  return result;
}
export function resolveBinary(name, env = process.env, cwd = process.cwd()) {
  const candidates = name.includes(path.sep) ? [path.resolve(cwd, name)] :
    (env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(cwd, directory, name));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); }
    catch { /* Continue PATH lookup without recording host paths. */ }
  }
  throw failure('RUNTIME_BINARY_UNAVAILABLE');
}
export function proxyPresence(env) { return Object.fromEntries(PROXY_KEYS.map(key => [key, Boolean(env[key])])); }
export function statistics(values) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!sorted.length) return { n: 0, min: null, median: null, p95: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  return { n: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2,
    p95: sorted[Math.ceil(sorted.length * .95)-1], max: sorted.at(-1) };
}
export function timing(launch, returned, f3, observed) {
  return { launchStartedAt: launch.wall, launchReturnedAt: returned?.wall ?? null, f3PublishedAtProxy: f3.ts,
    observedAt: observed.wall, launchDurationMs: returned ? returned.mono-launch.mono : null,
    publicationFromLaunchMs: f3.ts-launch.wall, publicationFromReturnMs: returned ? f3.ts-returned.wall : null,
    observedFromLaunchMs: observed.mono-launch.mono, observedFromReturnMs: returned ? observed.mono-returned.mono : null,
    publicationToObservationMs: observed.wall-f3.ts };
}
export function assertOrder(sequence, startupIds, businessId) {
  if (!startupIds.length || new Set(startupIds).size !== startupIds.length) throw failure('STARTUP_PROMPT_MISSING_OR_DUPLICATED');
  const seen = new Set();
  for (const entry of sequence) {
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) throw failure('DUPLICATE_DELIVERY');
    if (entry.kind === 'business' && (entry.id !== businessId || startupIds.some(id => !seen.has(`control:${id}`)))) throw failure('BUSINESS_BEFORE_STARTUP');
    seen.add(key);
  }
  if (!seen.has(`business:${businessId}`)) throw failure('BUSINESS_NOT_DELIVERED');
}
export async function runWorker(request, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./router-ready-worker.js', import.meta.url))], {
      env, stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
    });
    let result;
    child.on('message', message => { result = message; });
    // Worker owns bounded cleanup; this backstop only diagnoses a hung worker.
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(failure('WORKER_START_FAILED')); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!result || signal || code !== 0) reject(Object.assign(failure(signal ? 'WORKER_DEADLINE' : 'WORKER_FAILED'), { cleanupUnknown: true }));
      else resolve(result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}
const LATENCY_METRICS = ['publicationFromLaunchMs','publicationFromReturnMs','observedFromLaunchMs','observedFromReturnMs'];
export function sampleAccounting(sample, job) {
  const readyValid = Number.isFinite(sample.timing?.publicationFromLaunchMs);
  const cleanupFailed = sample.homeRemoved !== true || Boolean(sample.cleanupError);
  const excludedReasons = [];
  if (job.case !== 'normal') excludedReasons.push('fault_injection');
  if (cleanupFailed) excludedReasons.push('cleanup_failed');
  if (!sample.ok && !cleanupFailed) excludedReasons.push('measurement_failed');
  if (job.case === 'normal' && !LATENCY_METRICS.every(metric => Number.isFinite(sample.timing?.[metric]))) excludedReasons.push('timing_missing');
  return { readyValid, cleanupFailed, excludedReasons, aggregateEligible: excludedReasons.length === 0 };
}
function emptyCounts() { return { collected: 0, readyValid: 0, cleanupFailed: 0, includedInAggregates: 0, excludedFromAggregates: 0, exclusionReasons: {} }; }
function countSample(counts, accounting) {
  counts.collected++; counts.readyValid += Number(accounting.readyValid); counts.cleanupFailed += Number(accounting.cleanupFailed);
  counts[accounting.aggregateEligible ? 'includedInAggregates' : 'excludedFromAggregates']++;
  for (const reason of accounting.excludedReasons) counts.exclusionReasons[reason] = (counts.exclusionReasons[reason] || 0) + 1;
}

export async function runMeasurements(config, env = process.env, worker = runWorker) {
  fs.mkdirSync(config.evidenceDir, { recursive: true, mode: 0o700 });
  const runDir = fs.mkdtempSync(path.join(config.evidenceDir, 'run-'));
  fs.chmodSync(runDir, 0o700);
  const samplesFile = path.join(runDir, 'samples.jsonl');
  fs.writeFileSync(samplesFile, '', { mode: 0o600 });
  const summary = { schema: 1, status: 'preflight', os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    machine: { label: config.machineLabel || `${os.platform()} ${os.arch()}`, cpuModel: os.cpus()[0]?.model || 'unknown', logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
    node: process.version, config: Object.fromEntries(Object.entries(config).filter(([key]) => !['binaries','evidenceDir'].includes(key))),
    proxy: proxyPresence(env), preflight: [], sampleCount: 0, counts: emptyCounts(), countsByRuntimeCondition: {}, samples: [], aggregates: {}, allTemporaryHomesRemoved: true,
    timingNote: 'F3.ts is the hook timestamp immediately before publication, not the filesystem rename instant. observedAt is separate; polling plus read/scheduling latency affects observed times. Publication deltas are signed wall-clock deltas.',
    conditions: { cold: 'fresh isolated HOME and runtime session; OS/binary caches are not flushed', repeat: 'one unmeasured successful warm-up in the same HOME, stopped before the measured launch; HOME removed after this sample',
      faults: 'controlled M1 clock; real adapter and M3 hook, excluded from startup latency aggregates', delivery: 'ledger-settling sequence recorder; no text pasted to the model' } };
  const writeSummary = () => fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  try {
    preflightInputs(config.runtimes, env);
    const workerEnv = measurementEnv(env);
    for (const runtime of config.runtimes) {
      const record = await worker({ type: 'preflight', runtime, config }, workerEnv, 180000);
      summary.preflight.push(record);
      summary.allTemporaryHomesRemoved &&= record.homeRemoved === true;
      if (!record.ok) throw failure(record.error || 'PREFLIGHT_FAILED');
    }
    summary.status = 'sampling';
    for (const runtime of config.runtimes) {
      const jobs = [];
      if (config.cases.includes('normal')) {
        for (const condition of ['cold','repeat']) for (let index = 0; index < config[`${condition}Count`]; index++) jobs.push({ condition, case: 'normal', index });
      }
      for (const kind of config.cases.filter(c => c !== 'normal')) jobs.push({ condition: 'fault', case: kind, index: 0 });
      for (const job of jobs) {
        const sample = await worker({ type: 'sample', runtime, config, ...job }, workerEnv, 180000 + config.observationMs * (job.condition === 'repeat' ? 2 : 1));
        const accounting = sampleAccounting(sample, job);
        fs.appendFileSync(samplesFile, JSON.stringify({ ...sample, accounting })+'\n');
        countSample(summary.counts, accounting);
        countSample(summary.countsByRuntimeCondition[`${runtime}/${job.condition}`] ??= emptyCounts(), accounting);
        summary.samples.push({ runtime, ...job, ok: sample.ok, error: sample.error ?? null, outcome: sample.outcome ?? null, accounting });
        summary.sampleCount++;
        summary.allTemporaryHomesRemoved &&= sample.homeRemoved === true;
        if (accounting.aggregateEligible) {
          const key = `${runtime}/${job.condition}`;
          const bucket = summary.aggregates[key] ??= { publicationFromLaunchMs: [], publicationFromReturnMs: [], observedFromLaunchMs: [], observedFromReturnMs: [] };
          for (const metric of Object.keys(bucket)) bucket[metric].push(sample.timing[metric]);
        }
      }
    }
    summary.status = summary.samples.every(s => s.ok) && summary.allTemporaryHomesRemoved ? 'complete' : 'failed';
  } catch (error) {
    summary.status = 'failed';
    summary.error = /^[a-zA-Z][a-zA-Z0-9_]+$/.test(error.code || '') ? error.code : 'MEASUREMENT_FAILED';
    if (error.cleanupUnknown) summary.allTemporaryHomesRemoved = false;
  } finally {
    for (const bucket of Object.values(summary.aggregates)) for (const metric of Object.keys(bucket)) bucket[metric] = statistics(bucket[metric]);
    writeSummary();
  }
  return { ok: summary.status === 'complete', runDir, summary };
}
