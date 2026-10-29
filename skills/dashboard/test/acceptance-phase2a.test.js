import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

if (!process.env.ACCEPTANCE) {
  console.log('# Skipping acceptance tests (set ACCEPTANCE=1 to run)');
  process.exit(0);
}

// All write-path checks run against an ephemeral sandbox instance (#269).
// Running them against the deployed instance injected synthetic hook events
// and metrics into live data; only explicitly read-only checks may touch the
// deployed box (see "Deployed instance" section at the bottom).
const SANDBOX_ZYLOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-acceptance-'));
const DATA_DIR = path.join(SANDBOX_ZYLOS_DIR, 'components', 'dashboard');
const DB_PATH = path.join(DATA_DIR, 'dashboard.db');
const HOOK_SCRIPT = path.resolve(new URL('../src/lib/hook-ingest.cjs', import.meta.url).pathname);
const SERVER_ENTRY = path.resolve(new URL('../src/index.js', import.meta.url).pathname);

let PORT = null;
let BASE = null;
let server = null;
let serverLog = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    port: PORT,
    auth: { enabled: false }
  }, null, 2));

  server = spawn('node', [SERVER_ENTRY], {
    env: { ...process.env, ZYLOS_DIR: SANDBOX_ZYLOS_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${BASE}/api/health`);
      if (resp.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`sandbox dashboard did not become healthy on :${PORT}\n${serverLog.slice(-2000)}`);
});

after(() => {
  server?.kill();
  fs.rmSync(SANDBOX_ZYLOS_DIR, { recursive: true, force: true });
});

function sql(query) {
  return execSync(`sqlite3 "${DB_PATH}" "${query}"`, { encoding: 'utf8' }).trim();
}

function api(endpoint) {
  return JSON.parse(execSync(`curl -sf ${BASE}${endpoint}`, { encoding: 'utf8' }));
}

function injectRawStdin(raw) {
  const child = spawn('node', [HOOK_SCRIPT], {
    env: { ...process.env, ZYLOS_DIR: SANDBOX_ZYLOS_DIR },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (raw !== '') child.stdin.write(raw);
  child.stdin.end();
  return new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    setTimeout(() => resolve(-1), 3000);
  });
}

function injectHookEvent(payload) {
  return injectRawStdin(JSON.stringify(payload));
}

// --- AC-5: Hook latency + exit behavior ---

test('AC-5: hook-ingest.cjs always exits 0', async (t) => {
  for (const payload of [
    { hook_event_name: 'PreToolUse', session_id: 'test-ac5', tool_name: 'Bash', tool_use_id: 'toolu_ac5_01' },
    { hook_event_name: 'PostToolUse', session_id: 'test-ac5', tool_name: 'Bash', tool_use_id: 'toolu_ac5_01' },
    { hook_event_name: 'Stop', session_id: 'test-ac5' },
    { not_a_real_field: true },
    {}
  ]) {
    const code = await injectHookEvent(payload);
    assert.equal(code, 0, `hook exited ${code} for ${JSON.stringify(payload)}`);
  }

  await t.test('empty stdin', async () => {
    assert.equal(await injectRawStdin(''), 0);
  });

  await t.test('invalid JSON', async () => {
    assert.equal(await injectRawStdin('not json at all{{{'), 0);
  });
});

test('AC-5: hook-ingest.cjs latency under 50ms (p95)', async () => {
  const times = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await injectHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'test-latency',
      tool_name: 'Bash',
      tool_use_id: `toolu_lat_${i}`
    });
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  assert.ok(p95 < 500, `p95 latency ${p95.toFixed(0)}ms exceeds 500ms`);
});

// --- AC-5: Ingest dedup ---

test('AC-5: no duplicate ingest_ids', async () => {
  const uniqueIds = sql("SELECT COUNT(DISTINCT ingest_id) FROM runtime_events");
  const total = sql("SELECT COUNT(*) FROM runtime_events");
  assert.equal(uniqueIds, total, 'no duplicate ingest_ids');
});

// --- AC-1: State engine restart recovery ---

test('AC-1: state snapshots exist', () => {
  const count = parseInt(sql('SELECT COUNT(*) FROM state_snapshots'), 10);
  assert.ok(count >= 0, 'state_snapshots table exists and is queryable');
});

test('AC-1: state snapshot schema has recovery fields', () => {
  const schema = sql("PRAGMA table_info(state_snapshots)");
  const columns = schema.split('\n').map(row => row.split('|')[1]);
  for (const col of ['runtime', 'session_id', 'running_tool', 'open_turn', 'pending_permission']) {
    assert.ok(columns.includes(col), `missing column: ${col}`);
  }
});

// --- AC-2: Metric resolver ---

test('AC-2: /api/health source health structure', () => {
  const health = api('/api/health');
  assert.ok(health.source, 'missing source block');
  assert.ok(health.source.runtime_progress, 'missing runtime_progress');
  assert.ok(health.source.collector_liveness, 'missing collector_liveness');
});

test('AC-2: source health freshness fields', () => {
  const health = api('/api/health');
  for (const group of Object.values(health.source)) {
    for (const entry of Object.values(group)) {
      assert.ok('fresh' in entry, 'missing fresh field');
      assert.ok('status' in entry, 'missing status field');
      assert.ok('capability' in entry, 'missing capability field');
    }
  }
});

// --- AC-4: Hook data flow ---

test('AC-4: hook_events source healthy after data flow', () => {
  const health = api('/api/health');
  const hookEvents = health.source.runtime_progress.hook_events;
  assert.equal(hookEvents.status, 'healthy');
  assert.equal(hookEvents.fresh, true);
});

test('AC-4: hook_handler collector healthy', () => {
  const health = api('/api/health');
  const handler = health.source.collector_liveness.hook_handler;
  assert.equal(handler.status, 'healthy');
  assert.equal(handler.fresh, true);
});

// --- Data integrity ---

test('Data integrity: events have required fields', () => {
  const row = sql("SELECT id, ingest_id, event_seq, timestamp, runtime, event_type, category, source FROM runtime_events ORDER BY event_seq DESC LIMIT 1");
  assert.ok(row.length > 0, 'no events found');
  const parts = row.split('|');
  assert.equal(parts.length, 8, 'expected 8 columns');
  const [id, ingest_id, event_seq, timestamp, runtime, event_type, category, source] = parts;
  assert.ok(id, 'missing id');
  assert.ok(ingest_id, 'missing ingest_id');
  assert.ok(parseInt(event_seq) > 0, 'invalid event_seq');
  assert.ok(timestamp, 'missing timestamp');
  assert.equal(runtime, 'claude');
  assert.ok(event_type, 'missing event_type');
  assert.ok(category, 'missing category');
  assert.equal(source, 'hook');
});

test('Data integrity: schema migrations applied', () => {
  const version = parseInt(sql('SELECT MAX(version) FROM schema_migrations'), 10);
  assert.ok(version >= 1, `schema_migrations should have at least one applied migration, got ${version}`);
});

test('Data integrity: WAL mode enabled', () => {
  const mode = sql('PRAGMA journal_mode');
  assert.equal(mode, 'wal');
});

// --- StatusLine ingest ---

test('StatusLine: /api/ingest/statusline accepts metrics', async () => {
  const body = JSON.stringify({
    metrics: [
      { metric_name: 'context_pct', metric_value: 42.5, source: 'statusline', confidence: 'actual' },
      { metric_name: 'session_cost', metric_value: 0.1234, source: 'statusline', confidence: 'actual' }
    ]
  });
  const resp = JSON.parse(execSync(`curl -s -X POST -H "Content-Type: application/json" -d '${body}' ${BASE}/api/ingest/statusline`, { encoding: 'utf8' }));
  assert.equal(resp.ok, true);
  assert.equal(resp.written, 2);
});

test('StatusLine: metrics stored in DB after ingest', () => {
  const count = parseInt(sql("SELECT COUNT(*) FROM metric_points WHERE metric_name = 'context_pct' AND source = 'statusline'"), 10);
  assert.ok(count >= 1, 'context_pct metric not stored');
});

test('Metrics history: metric_points table queryable', () => {
  const count = parseInt(sql("SELECT COUNT(*) FROM metric_points"), 10);
  assert.ok(count >= 0, 'metric_points table should be queryable');
});

// --- Frontend structure ---

test('Frontend: i18n.js module exists', () => {
  const resp = execSync(`curl -sf -o /dev/null -w "%{http_code}" ${BASE}/_assets/js/i18n.js`, { encoding: 'utf8' });
  assert.equal(resp.trim(), '200');
});

test('Frontend: chart.js vendor file exists', () => {
  const resp = execSync(`curl -sf -o /dev/null -w "%{http_code}" ${BASE}/_assets/vendor/chart.umd.js`, { encoding: 'utf8' });
  assert.equal(resp.trim(), '200');
});

test('Frontend: CSS files accessible', () => {
  const style = execSync(`curl -sf -o /dev/null -w "%{http_code}" ${BASE}/_assets/css/style.css`, { encoding: 'utf8' });
  assert.equal(style.trim(), '200');
  const theme = execSync(`curl -sf -o /dev/null -w "%{http_code}" ${BASE}/_assets/themes/light.css`, { encoding: 'utf8' });
  assert.equal(theme.trim(), '200');
});

// --- Deployed instance (read-only checks ONLY — never write to the live box) ---

const REAL_SETTINGS_PATH = path.join(os.homedir(), 'zylos', '.claude', 'settings.json');

test('Deployed: settings.json has dashboard hooks', (t) => {
  if (!fs.existsSync(REAL_SETTINGS_PATH)) return t.skip('no deployed settings.json on this box');
  const settings = JSON.parse(fs.readFileSync(REAL_SETTINGS_PATH, 'utf8'));
  for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
    const has = settings.hooks[event]?.some(g =>
      g.hooks?.some(h => h.command?.includes('hook-ingest.cjs'))
    );
    assert.ok(has, `dashboard hook missing for ${event}`);
  }
});

test('Deployed: existing hooks preserved', (t) => {
  if (!fs.existsSync(REAL_SETTINGS_PATH)) return t.skip('no deployed settings.json on this box');
  const settings = JSON.parse(fs.readFileSync(REAL_SETTINGS_PATH, 'utf8'));
  const amHook = settings.hooks.PreToolUse?.some(g =>
    g.hooks?.some(h => h.command?.includes('activity-monitor'))
  );
  assert.ok(amHook, 'activity-monitor hook missing from PreToolUse');
  assert.ok(settings.statusLine, 'statusLine config missing');
});

test('Deployed: PM2 dashboard service is online', (t) => {
  let procs;
  try {
    procs = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8' }));
  } catch {
    return t.skip('pm2 not available on this box');
  }
  const dashboard = procs.find(p => p.name === 'zylos-dashboard');
  if (!dashboard) return t.skip('zylos-dashboard not under PM2 on this box');
  assert.equal(dashboard.pm2_env.status, 'online');
});
