#!/usr/bin/env node
// Storm replay benchmark for #260: boots the dashboard from this checkout in
// an isolated ZYLOS_DIR sandbox, replays captured hook events against
// /api/ingest with storm-level concurrency, and measures HTTP liveness
// (/api/health probe latency) plus event-loop stats while the storm runs.
//
// Usage:
//   node scripts/bench-storm-replay.cjs --label after --capture <raw-hooks.jsonl> \
//     [--count 3000] [--concurrency 35] [--port 3478] [--sandbox /tmp/bench-260-after]
//
// Output: one JSON report on stdout (everything else goes to stderr).
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ALLOWED_EVENTS = new Set([
  'SessionStart',
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest',
  'SubagentStart', 'SubagentStop'
]);
const MAX_BODY_BYTES = 60 * 1024; // stay under the server's 64KB readJsonBody cap

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const LABEL = arg('label', 'run');
const CAPTURE = arg('capture');
const COUNT = Number(arg('count', 3000));
const CONCURRENCY = Number(arg('concurrency', 35));
const PORT = Number(arg('port', 3478));
const SANDBOX = arg('sandbox', `/tmp/bench-260-${LABEL}`);
const PROBE_INTERVAL_MS = 50;
const PROBE_TIMEOUT_MS = 8000; // mirrors fleet timeout_ms

if (!CAPTURE) {
  console.error('Missing --capture <raw-hooks.jsonl>');
  process.exit(1);
}

const BASE = `http://127.0.0.1:${PORT}`;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    max_ms: sorted[sorted.length - 1] ?? null
  };
}

async function loadEvents() {
  const events = [];
  let skippedType = 0;
  let skippedSize = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(CAPTURE),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (events.length >= COUNT) break;
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_BODY_BYTES) { skippedSize++; continue; }
    let payload;
    try { payload = JSON.parse(line); } catch { continue; }
    const name = payload.hook_event_name || payload._hook_event;
    if (!name || !ALLOWED_EVENTS.has(name)) { skippedType++; continue; }
    delete payload._captured_at;
    delete payload._hook_event;
    delete payload._runtime;
    payload.hook_event_name = name;
    events.push(payload);
  }
  rl.close();
  console.error(`[bench] loaded ${events.length} events (skipped ${skippedType} by type, ${skippedSize} oversized)`);
  return events;
}

function writeSandbox() {
  const dataDir = path.join(SANDBOX, 'components', 'dashboard');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, 'spool'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: PORT,
    host: '127.0.0.1',
    ingestToken: null,
    auth: { enabled: false },
    fleet: { agents: [] }
  }, null, 2));
  return dataDir;
}

async function fetchJson(url, opts = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const body = await resp.json().catch(() => null);
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForListen(deadlineMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const { status } = await fetchJson(`${BASE}/api/health`, {}, 2000);
      if (status === 200) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start listening in time');
}

async function main() {
  const dataDir = writeSandbox();
  const events = await loadEvents();

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, ZYLOS_DIR: SANDBOX, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => process.stderr.write(`[server] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[server!] ${d}`));
  const serverExit = new Promise(r => server.on('exit', r));

  try {
    await waitForListen();
    console.error('[bench] server up, settling 3s (startup drain/collectors)');
    await new Promise(r => setTimeout(r, 3000));

    // Health probe loop — the "is the dashboard alive while the storm rages"
    // signal. Runs until stopped; failures and timeouts are counted.
    const probe = { samples: [], timeouts: 0, errors: 0, stop: false };
    const probeLoop = (async () => {
      while (!probe.stop) {
        const t0 = process.hrtime.bigint();
        try {
          await fetchJson(`${BASE}/api/health`);
          probe.samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
        } catch (err) {
          if (err.name === 'AbortError') probe.timeouts++;
          else probe.errors++;
        }
        await new Promise(r => setTimeout(r, PROBE_INTERVAL_MS));
      }
    })();

    // Replay: CONCURRENCY workers, each behaving like one hook process — POST
    // the next event, wait for the ACK, move on.
    const postStats = { samples: [], codes: {} };
    let cursor = 0;
    const replayStart = process.hrtime.bigint();
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < events.length) {
        const payload = events[cursor++];
        const body = JSON.stringify({
          ...payload,
          ingest_id: crypto.randomUUID(),
          received_at: new Date().toISOString(),
          runtime: 'claude'
        });
        const t0 = process.hrtime.bigint();
        try {
          const { status } = await fetchJson(`${BASE}/api/ingest`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body
          });
          postStats.codes[status] = (postStats.codes[status] || 0) + 1;
        } catch {
          postStats.codes.network_error = (postStats.codes.network_error || 0) + 1;
        }
        postStats.samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    }));
    const sendDurationMs = Number(process.hrtime.bigint() - replayStart) / 1e6;
    console.error(`[bench] all ${events.length} events POSTed in ${Math.round(sendDurationMs)}ms`);

    // Wait for the queue (if present) to fully drain so both revisions are
    // compared on completed work, not just accepted work.
    let drainDurationMs = 0;
    let finalHealth = null;
    let drainWaitTimeouts = 0;
    const drainStart = process.hrtime.bigint();
    for (;;) {
      // The health check itself can time out while the loop is still wedged
      // (observed on the pre-queue revision) — that's data, not a harness error.
      try {
        const { body } = await fetchJson(`${BASE}/api/health`);
        finalHealth = body;
        const depth = body?.ingest_queue?.depth;
        if (depth === undefined || depth === 0) break;
      } catch {
        drainWaitTimeouts++;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    drainDurationMs = Number(process.hrtime.bigint() - drainStart) / 1e6;

    probe.stop = true;
    await probeLoop;

    // Let the event-loop monitor close out its current 5s window so the storm
    // shows up in the rolling stats, then take the final snapshot.
    await new Promise(r => setTimeout(r, 5500));
    const settledHealth = await fetchJson(`${BASE}/api/health`)
      .then(r => r.body)
      .catch(() => null);

    const dbPath = path.join(dataDir, 'dashboard.db');
    const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
    const db = new Database(dbPath, { readonly: true });
    const dbRows = db.prepare('SELECT COUNT(*) AS c FROM runtime_events').get().c;
    db.close();

    const spoolPath = path.join(dataDir, 'spool', 'hook-events.jsonl');
    const spoolLines = fs.existsSync(spoolPath)
      ? fs.readFileSync(spoolPath, 'utf8').split('\n').filter(Boolean).length
      : 0;

    const report = {
      label: LABEL,
      git_rev: process.env.BENCH_GIT_REV || null,
      events_sent: events.length,
      concurrency: CONCURRENCY,
      batch_size_default: 25,
      send_duration_ms: Math.round(sendDurationMs),
      drain_duration_ms: Math.round(drainDurationMs),
      total_duration_ms: Math.round(sendDurationMs + drainDurationMs),
      throughput_eps: Math.round(events.length / ((sendDurationMs + drainDurationMs) / 1000)),
      post_ack: { ...summarize(postStats.samples), codes: postStats.codes },
      health_probe: {
        ...summarize(probe.samples),
        timeouts: probe.timeouts,
        errors: probe.errors,
        interval_ms: PROBE_INTERVAL_MS
      },
      drain_wait_health_timeouts: drainWaitTimeouts,
      event_loop: settledHealth?.event_loop ?? finalHealth?.event_loop ?? null,
      ingest_queue: finalHealth?.ingest_queue ?? null,
      db_rows: dbRows,
      spool_lines_remaining: spoolLines
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.kill('SIGTERM');
    await Promise.race([serverExit, new Promise(r => setTimeout(r, 5000))]);
    server.kill('SIGKILL');
  }
}

main().catch(err => {
  console.error(`[bench] FAILED: ${err.stack}`);
  process.exit(1);
});
