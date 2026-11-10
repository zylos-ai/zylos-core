import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../comm-bridge/scripts/c4-schema.js';
import { startSupervisor } from '../supervisor-main.js';

// Real entry -> default sendAlert -> real C4 CLI -> fixture channel. Run when
// supervisor system-send identity or transport wiring changes; otherwise skip.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR. This fixture
// adds a private SQLite DB, am.sock and node-only PATH; no tmux/PM2/network.
// No scheduled loop is started. The real sender has a 30-second child timeout;
// entry shutdown drains pending sends before closing DB and removing the root.
test('default supervisor alert delivery clears inherited session identity', { timeout: 40000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sys-alert-'));
  const bin = path.join(root, 'bin'), tmp = path.join(root, 'tmp');
  const channel = path.join(root, '.claude', 'skills', 'fixture', 'scripts');
  const marker = path.join(root, 'delivered.json');
  const databasePath = path.join(root, 'comm-bridge', 'c4.db');
  for (const dir of [bin, tmp, channel, path.dirname(databasePath), path.join(root, '.zylos')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, '.zylos', 'config.json'), '{"runtime":"claude","session_mode":"multi"}');
  fs.writeFileSync(path.join(channel, 'send.js'), `import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      argv: process.argv.slice(2),
      runId: process.env.ZYLOS_RUN_ID ?? null,
      sessionGroup: process.env.ZYLOS_SESSION_GROUP ?? null,
      home: process.env.HOME, zylosDir: process.env.ZYLOS_DIR,
      pm2Home: process.env.PM2_HOME, tmpdir: process.env.TMPDIR,
      path: process.env.PATH
    }));`);
  const env = {
    HOME: path.join(root, 'home'), ZYLOS_DIR: root,
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: tmp, TMUX_TMPDIR: tmp,
    PATH: bin, ZYLOS_PACKAGE_ROOT: fileURLToPath(new URL('../../../../', import.meta.url)),
    ZYLOS_RUN_ID: 'stale-supervisor-run', ZYLOS_SESSION_GROUP: 'fixture:sender',
  };
  fs.mkdirSync(env.HOME);
  for (const key of ['HOME', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'PATH']) {
    assert.ok(env[key].startsWith(root + path.sep), key);
  }
  assert.equal(fs.realpathSync(env.ZYLOS_DIR), root);
  assert.ok(databasePath.startsWith(root + path.sep));
  assert.deepEqual(fs.readdirSync(bin), ['node']);
  const socketPath = path.join(root, 'activity-monitor', 'am.sock');
  assert.ok(Buffer.byteLength(socketPath) < 104);
  console.log('Supervisor alert isolation:', JSON.stringify({ env, databasePath, socketPath }));

  const database = new Database(databasePath);
  guardDatabase(database, schema); database.pragma('journal_mode=WAL');
  const store = createStore(database, { validateComponent: name => name === 'fixture' });
  store.insertConversation('in', 'fixture', 'room', 'incoming', { groupName: 'responsible' });
  let service;
  t.after(async () => {
    try { await service?.stop(); }
    finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  const db = {
    getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    listPendingSessionGroups: () => [], listPendingContinuations: () => [], listRunEndings: () => [],
    listSlotOccupancy: () => [], pruneSlots: () => ({ deletedHeld: 0, deletedOrphans: [] }),
    getLastCompletedModeTransition: () => null, getControlById: () => null,
    getOriginNeed: () => ({ inbound: { count: 0, oldestAt: null }, controls: { count: 0 } }),
    getOriginSyncBacklog: () => ({ total: 0, groups: [] }),
    resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }),
  };
  const scenes = {
    observe: async () => [], readIdentity: async () => ({ present: false }),
    observeGroup: async () => ({ present: false }), listRuns: async () => [], readRun: async () => null,
  };
  service = await startSupervisor({
    env, db, scenes, readMode: () => ({ mode: 'single', keyPresent: true }),
    readConfig: () => ({ session_mode: 'single', runtime: 'claude', alert_target: 'fixture:room' }),
    legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
    loopOptions: { schedule: () => 1, cancel() {} }, log: () => {},
  });
  await service.supervisor.loop.deps.startupAlert({ event: 'system_notice' });
  assert.equal(fs.existsSync(marker), true, 'default C4 child must reach the fixture channel');
  const delivered = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(delivered.runId, null);
  assert.equal(delivered.sessionGroup, null);
  assert.equal(delivered.argv[0], 'room');
  assert.match(delivered.argv[1], /Supervisor: system_notice/);
  assert.equal(delivered.home, env.HOME);
  assert.equal(delivered.zylosDir, env.ZYLOS_DIR);
  assert.equal(delivered.pm2Home, env.PM2_HOME);
  assert.equal(delivered.tmpdir, env.TMPDIR);
  assert.equal(delivered.path, env.PATH);
  assert.equal(env.ZYLOS_RUN_ID, 'stale-supervisor-run');
  assert.equal(env.ZYLOS_SESSION_GROUP, 'fixture:sender');
  const rows = database.prepare("SELECT * FROM conversations WHERE direction='out'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_group, 'fixture:responsible');
  assert.equal(rows[0].endpoint_id, 'room');
  assert.equal(rows[0].status, 'delivered');
});
