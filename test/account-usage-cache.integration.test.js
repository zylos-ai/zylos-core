import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AccountUsageCache } from '../skills/dashboard/src/lib/account-usage-cache.js';

// Boundary: real Core account reader → shared cache → CoreState + live-only cache reader.
// Run when changing account selection, cache TTL/coalescing, or either consumer;
// unrelated UI-only changes may skip this case. No optional tools/dependencies.
// Isolation: runner-provided HOME/ZYLOS_DIR/PM2_HOME/TMPDIR are checked below;
// all sample files use a nested fixture. Identity/tmux connections are injected,
// so no real tmux process is exercised and a private tmux socket is N/A.
test('CoreState and live-only reads share real account scan until 30s expiry, preserving quota policies and provenance', async t => {
  const runnerHome = fs.realpathSync(process.env.HOME);
  const realHome = fs.realpathSync(os.userInfo().homedir);
  assert.notEqual(runnerHome, realHome);
  assert.equal(process.env.ZYLOS_DIR, path.join(runnerHome, 'zylos'));
  assert.equal(process.env.PM2_HOME, path.join(runnerHome, '.pm2'));
  assert.equal(fs.realpathSync(process.env.TMPDIR), path.join(path.dirname(runnerHome), 'tmp'));
  assert.equal(os.homedir(), runnerHome);
  t.diagnostic(JSON.stringify({ isolation: Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]])
  ), tmux: 'identity/connection mocks; real tmux not exercised; private socket N/A' }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lib = path.join(root, 'package/cli/lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(root, 'package/package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(lib, 'config.js'), 'export function readSessionMode(){return {mode:"single"}}');
  const createReaderUrl = new URL('../cli/lib/session-state-reader-async.js', import.meta.url).href;
  fs.writeFileSync(path.join(lib, 'session-state-reader.js'), `
    import { createSessionReader } from ${JSON.stringify(createReaderUrl)};
    export const counters = { scans: 0 };
    const reader = createSessionReader({ env: { ZYLOS_DIR: ${JSON.stringify(root)} },
      open: async () => ({close: async () => {}}),
      observe: async () => ({present:true,ready:true,runtime:'claude',runId:'run',sessionId:'session'}),
      observeAll: async () => new Map([['origin', {present:true,ready:true,runtime:'claude',runId:'run',sessionId:'session'}]])
    });
    export const {readSessionState,readSessionStates} = reader;
    export async function readAccountUsageSnapshot(runtime) {
      counters.scans++;
      return reader.readAccountUsageSnapshot(runtime);
    }
  `);
  const write = (group, percent, capturedAt) => {
    const dir = path.join(root, 'activity-monitor/session-groups', group);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'statusline.json');
    fs.writeFileSync(file, JSON.stringify({ session_id: 'session', zylos: {v:1,runId:'run',capturedAt},
      context_window: {used_percentage:35},
      rate_limits: {seven_day:{used_percentage:percent,resets_at:Date.now()/1000+86400}} }));
    return file;
  };
  const capturedAt = Date.now() - 1000;
  write('origin', 7, capturedAt);
  write('sleeping', 12, capturedAt + 500);
  const prior = process.env.ZYLOS_PACKAGE_ROOT;
  process.env.ZYLOS_PACKAGE_ROOT = path.join(root, 'package');
  t.after(() => { if (prior === undefined) delete process.env.ZYLOS_PACKAGE_ROOT; else process.env.ZYLOS_PACKAGE_ROOT = prior; });
  const reader = await import(pathToFileURL(path.join(lib, 'session-state-reader.js')).href);
  const { CoreState } = await import('../skills/dashboard/src/lib/core-state.js');
  let clock = 0;
  const cache = new AccountUsageCache({now: () => clock});
  const sessionObservations = {
    async get() {
      return { mode: 'single', group: null,
        observations: await reader.readSessionStates([null], { freshnessMs: 5000 }), reader };
    },
    async resolveOfflineRuntime() { return 'claude'; },
  };
  const core = new CoreState({ zylosDir: root, accountUsageCache: cache, sessionObservations });
  const readLive = () => cache.read('claude', undefined, reader);
  let live;
  await Promise.all([core.refresh(), readLive().then(value => { live = value; })]);
  assert.equal(reader.counters.scans, 1, 'concurrent readers coalesce');
  assert.equal(core.accountUsage.seven_day.used_percentage, 12, 'Core keeps recorded selection');
  assert.equal(live.seven_day.used_percentage, 7, 'live-only selection stays independent');
  for (let i = 1; i < 20; i++) { clock = i * 1000; await core.refresh(); if (i % 2 === 0) await readLive(); }
  assert.equal(reader.counters.scans, 1, 'unchanged polling reuses the account snapshot');
  write('sleeping', 23, capturedAt + 750);
  clock = 29999;
  await core.refresh();
  assert.equal(core.accountUsage.seven_day.used_percentage, 12);
  clock = 30000;
  await Promise.all([core.refresh(), readLive().then(value => { live = value; })]);
  assert.equal(reader.counters.scans, 2);
  assert.equal(core.accountUsage.seven_day.used_percentage, 23);
  assert.equal(live.seven_day.used_percentage, 7);
  const codex = await cache.read('codex', {allowRecorded:true}, reader);
  assert.equal(reader.counters.scans, 3, 'runtime cache entries stay separate');
  assert.equal(codex, null);
  await core.stop();
});
