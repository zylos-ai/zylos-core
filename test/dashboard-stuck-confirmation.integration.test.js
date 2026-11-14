import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { StateEngine } from '../skills/dashboard/src/lib/state-engine.js';
import { publishSessionStatus } from '../skills/activity-monitor/scripts/status-writer.js';

// Boundary: production heartbeat writer → file reader → SQLite collector health → StateEngine.
// Run for stuck confirmation or heartbeat identity/freshness changes; skip unrelated UI work.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and removes its private files.
// The owned SQLite store closes with the test lifecycle; no tmux, child process or live PM2 is used.
// The clock advances explicitly; this proves state logic, not a real-time 15-minute soak.
test('heartbeat writer and file reader confirm sustained inactivity with SQLite collector health', { timeout: 15000 }, t => {
  const root = process.env.ZYLOS_DIR;
  assert(root?.startsWith('/tmp/'));
  for (const key of ['HOME', 'PM2_HOME', 'TMPDIR']) assert(process.env[key]?.startsWith('/tmp/'), key);
  const dbPath = path.join(root, 'dashboard', 'stuck.db');
  console.log(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root, PM2_HOME: process.env.PM2_HOME,
    TMPDIR: process.env.TMPDIR, database: dbPath }));
  const store = new Store(dbPath);
  t.after(() => store.close());
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), JSON.stringify({ session_mode: 'single' }));
  const statusPath = path.join(root, 'activity-monitor', 'agent-status.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  let clock = Date.now();
  const start = clock;
  const engine = new StateEngine(store, {}, { zylosDir: root, runtime: 'claude' }, { now: () => clock });
  function observe() {
    publishSessionStatus({ statusFile: statusPath,
      scene: { ready: true, runId: 'stalled-run', sessionId: 'stalled-session', runtime: 'claude' },
      activity: { sessionId: 'stalled-session', state: 'busy', lastActivityAt: start, tools: [{ tool_use_id: 'stalled-tool' }] },
      health: { health: 'ok' }, now: clock });
    fs.utimesSync(statusPath, clock / 1000, clock / 1000);
    for (const name of ['pm2_reader', 'system_sampler']) {
      store.upsertSourceHealth(name, 'collector_liveness', 'healthy', { last_success: new Date(clock).toISOString() });
    }
    engine._readAMHeartbeat();
    return engine.getState();
  }
  observe();
  engine.onEvent({ event_type: 'user_prompt_submit', runtime: 'claude', session_id: 'stalled-session',
    timestamp: new Date(start).toISOString(), metadata: {} });
  engine.onEvent({ event_type: 'pre_tool_use', runtime: 'claude', session_id: 'stalled-session',
    timestamp: new Date(start).toISOString(), metadata: { tool_use_id: 'stalled-tool', tool_name: 'Bash' } });
  clock += 301000;
  assert.equal(observe().state, 'POSSIBLY_STUCK');
  clock += 600000;
  const confirmed = observe();
  console.log(JSON.stringify({ elapsed_s: (clock - start) / 1000, state: confirmed.state,
    missing_evidence: confirmed.missing_evidence, collectors: store.getCollectorLiveness().map(row => row.name) }));
  assert.equal(confirmed.state, 'STUCK');
  clock += 3600000;
  assert.equal(observe().state, 'STUCK');
});
