import assert from 'node:assert/strict';
import { execFileSync, execSync, spawn } from 'node:child_process';
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
const CORE_RUN_DIR = path.join(SANDBOX_ZYLOS_DIR, 'activity-monitor', 'session-groups', 'origin');
const SANDBOX_HOME = path.join(SANDBOX_ZYLOS_DIR, 'home');
const SANDBOX_PM2_HOME = path.join(SANDBOX_ZYLOS_DIR, 'pm2');
const SANDBOX_TMPDIR = path.join(SANDBOX_ZYLOS_DIR, 'tmp');
const TMUX_SOCKET = path.join(SANDBOX_TMPDIR, 'tmux.sock');
const TMUX_BIN = process.env.TEST_TMUX_BIN || 'tmux';
const RUN_ID = 'acceptance-run';
const SESSION_ID = 'acceptance-session';
const SERVER_ENTRY = path.resolve(new URL('../src/index.js', import.meta.url).pathname);
const SERVER_PRELOAD = path.resolve(new URL('./fixtures/acceptance-server.js', import.meta.url).pathname);
const PACKAGE_ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);

let PORT = null;
let BASE = null;
let server = null;
let serverLog = '';
let statuslineTimer = null, cookie = null;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(description, read, accept, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) { lastError = error; }
    await pause(100);
  }
  throw new Error(`${description} did not arrive within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}\n${serverLog.slice(-2000)}`);
}

function tmux(...args) {
  return execFileSync(TMUX_BIN, ['-u', '-S', TMUX_SOCKET, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000
  }).trim();
}

function writeCoreStatusline() {
  fs.writeFileSync(path.join(CORE_RUN_DIR, 'statusline.json'), JSON.stringify({
    session_id: SESSION_ID,
    zylos: { v: 1, runId: RUN_ID, capturedAt: Date.now() },
    context_window: { used_percentage: 42.5 },
    cost: { total_cost_usd: 0.1234 }
  }));
}

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

// Boundary: real sandbox server/collectors/hooks and SQLite, authenticated health.
// Run when health/collector routing changes; skip for unrelated UI edits. Official
// runner isolates outer paths; every child uses this private HOME/ZYLOS/PM2/TMP
// and tmux socket, the server fixture blocks external network and teardown reaps it.
before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  for (const dir of [DATA_DIR, CORE_RUN_DIR, SANDBOX_HOME, SANDBOX_PM2_HOME, SANDBOX_TMPDIR, path.join(SANDBOX_ZYLOS_DIR, '.zylos')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
    port: PORT,
    auth: { enabled: true, password: 'acceptance-private-password' }
  }, null, 2));
  fs.writeFileSync(path.join(SANDBOX_ZYLOS_DIR, '.zylos', 'config.json'), JSON.stringify({
    runtime: 'claude',
    session_mode: 'single'
  }));
  fs.writeFileSync(path.join(CORE_RUN_DIR, 'current-session.json'), JSON.stringify({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    ts: Date.now(),
    startupControlIds: []
  }));
  fs.writeFileSync(path.join(CORE_RUN_DIR, 'agent-status.json'), JSON.stringify({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    state: 'idle'
  }));
  fs.writeFileSync(path.join(CORE_RUN_DIR, 'events.jsonl'), `${JSON.stringify({
    v: 1,
    ts: Date.now(),
    event: 'prompt',
    runtime: 'claude',
    session_group: 'origin',
    run_id: RUN_ID,
    session_id: SESSION_ID
  })}\n`);

  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'zylos-group-origin',
    '-e', `ZYLOS_RUN_ID=${RUN_ID}`,
    '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',
    'sleep', '120');

  console.log('Acceptance parent isolation:', JSON.stringify({ HOME: SANDBOX_HOME, ZYLOS_DIR: SANDBOX_ZYLOS_DIR, PM2_HOME: SANDBOX_PM2_HOME, TMPDIR: SANDBOX_TMPDIR, socket: TMUX_SOCKET, db: DB_PATH }));
  server = spawn('node', ['--import', SERVER_PRELOAD, SERVER_ENTRY], {
    env: {
      ...process.env,
      HOME: SANDBOX_HOME,
      PM2_HOME: SANDBOX_PM2_HOME,
      TMPDIR: SANDBOX_TMPDIR,
      TMUX: `${TMUX_SOCKET},0,0`,
      TMUX_TMPDIR: SANDBOX_TMPDIR,
      ZYLOS_DIR: SANDBOX_ZYLOS_DIR,
      ZYLOS_PACKAGE_ROOT: PACKAGE_ROOT
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => { serverLog = (serverLog + d).slice(-32_768); });
  server.stderr.on('data', d => { serverLog = (serverLog + d).slice(-32_768); });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${BASE}/api/health`);
      if (resp.ok) {
        const login = await fetch(BASE + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: 'acceptance-private-password' }) });
        assert.equal(login.status, 302); cookie = login.headers.get('set-cookie'); assert.ok(cookie);
        writeCoreStatusline();
        statuslineTimer = setInterval(writeCoreStatusline, 1000);
        return;
      }
    } catch { /* not up yet */ }
    await pause(250);
  }
  throw new Error(`sandbox dashboard did not become healthy on :${PORT}\n${serverLog.slice(-2000)}`);
});

after(async () => {
  clearInterval(statuslineTimer);
  if (server && server.exitCode == null) {
    await new Promise(resolve => { const timeout = setTimeout(() => server.kill('SIGKILL'), 3000); server.once('close', () => { clearTimeout(timeout); resolve(); }); server.kill(); });
  }
  try { tmux('kill-server'); } catch {}
  fs.rmSync(SANDBOX_ZYLOS_DIR, { recursive: true, force: true });
});

function sql(query) {
  return execSync(`sqlite3 "${DB_PATH}" "${query}"`, { encoding: 'utf8' }).trim();
}

function api(endpoint, authenticated = true) {
  return JSON.parse(execFileSync('curl', ['-sf', ...(authenticated ? ['-H', 'Cookie: ' + cookie] : []), BASE + endpoint], { encoding: 'utf8', timeout: 5000 }));
}

// --- Ingest dedup ---

test('no duplicate ingest_ids', async () => {
  const uniqueIds = sql("SELECT COUNT(DISTINCT ingest_id) FROM runtime_events");
  const total = sql("SELECT COUNT(*) FROM runtime_events");
  assert.equal(uniqueIds, total, 'no duplicate ingest_ids');
});

// --- State engine restart recovery ---

test('state snapshots exist', () => {
  const count = parseInt(sql('SELECT COUNT(*) FROM state_snapshots'), 10);
  assert.ok(count >= 0, 'state_snapshots table exists and is queryable');
});

test('state snapshot schema has recovery fields', () => {
  const schema = sql("PRAGMA table_info(state_snapshots)");
  const columns = schema.split('\n').map(row => row.split('|')[1]);
  for (const col of ['runtime', 'session_id', 'running_tool', 'open_turn', 'pending_permission']) {
    assert.ok(columns.includes(col), `missing column: ${col}`);
  }
});

// --- Metric resolver ---

test('public health contains only liveness and boot identity', () => {
  const health = api('/api/health', false);
  assert.deepEqual(Object.keys(health).sort(), ['bootId', 'ok', 'service']);
  assert.equal(health.ok, true);
});

test('state source health structure', () => {
  const health = api('/api/health');
  assert.ok(health.source, 'missing source block');
  assert.ok(health.source.runtime_progress, 'missing runtime_progress');
  assert.ok(health.source.collector_liveness, 'missing collector_liveness');
});

test('source health freshness fields', () => {
  const health = api('/api/health');
  for (const group of Object.values(health.source)) {
    for (const entry of Object.values(group)) {
      assert.ok('fresh' in entry, 'missing fresh field');
      assert.ok('status' in entry, 'missing status field');
      assert.ok('capability' in entry, 'missing capability field');
    }
  }
});

// --- Data integrity ---

test('Data integrity: running service imports Core log events with required fields', async () => {
  const row = await waitFor('Core log import',
    () => sql("SELECT id, ingest_id, event_seq, timestamp, runtime, event_type, category, source FROM runtime_events WHERE source = 'core-log' ORDER BY event_seq DESC LIMIT 1"),
    value => value.length > 0);
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
  assert.equal(source, 'core-log');
});

test('Data integrity: schema migrations applied', () => {
  const version = parseInt(sql('SELECT MAX(version) FROM schema_migrations'), 10);
  assert.ok(version >= 1, `schema_migrations should have at least one applied migration, got ${version}`);
});

test('Data integrity: WAL mode enabled', () => {
  const mode = sql('PRAGMA journal_mode');
  assert.equal(mode, 'wal');
});

// --- StatusLine collection ---

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
