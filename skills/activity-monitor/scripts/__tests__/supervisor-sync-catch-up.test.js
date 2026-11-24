import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';

// Unit fixture: database, runtime and marker observations are in memory.
// Alert persistence has a private tree per case; no processes, timers, live
// database, PM2 or tmux are started. Official runner isolates imports first.
const roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(mode = 'multi', configuration = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-catch-up-')); roots.push(root);
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'z'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp') };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(env[key].startsWith(root + path.sep)); fs.mkdirSync(env[key], { recursive: true });
  }
  const f = {
    now: 2_000_000, firstAt: 2_000_000, endedAt: 2000, count: 500, first: 1, lastActivity: 0,
    scene: { sessionGroup: mode === 'single' ? 'origin' : 'a', present: true, ready: true,
      runtime: 'claude', runId: 'run-a', sessionId: 'session-a', runDir: '/isolated/run',
      createdAt: 0, state: 'idle', idleSince: 0, processRunning: true, usagePercent: 0 },
    configuration: { mode, syncThreshold: 15, hotTtlSeconds: 1800, ...configuration },
    marker: { held: false, stale: false }, controls: [], markerReads: [],
    backlog: { total: 0, groups: [] }, rangeReads: [], transition: null,
  };
  const range = () => ({ count: f.count, firstConversationId: f.count ? f.first : null,
    firstAt: f.count ? f.firstAt : null });
  const deps = {
    env,
    db: {
      getModeTransition: () => f.transition,
      listRunEndings: groups => groups.map(sessionGroup => ({ sessionGroup, endedAt: f.endedAt })),
      getLastCompletedModeTransition: () => null,
      listDrainFences: () => [],
      getUnsummarizedRange: group => { f.rangeReads.push(group); return range(); },
      getOriginSyncBacklog: () => f.backlog,
      getLatestContentCheckpoint: () => null,
      getDeliveredFrontier: () => f.count ? f.first + f.count - 1 : 0,
      getLastActivity: () => ({ ts: f.lastActivity }),
      getControlById: id => f.controls.find(row => row.id === id),
      insertControl: (content, options) => {
        if (f.writeError) throw f.writeError;
        const row = { id: f.controls.length + 1, content, ...options, status: 'pending' };
        f.controls.push(row);
        return row;
      },
    },
    observeGroup: group => ({ ...f.scene, sessionGroup: group }),
    readSyncMarker: args => { f.markerReads.push(args); return f.marker; },
    requests: { read: () => [] },
    groupRunDir: group => `/isolated/${group}`,
    bindTarget: scene => ({ expectedRunId: scene.runId }),
    prompts: { GROUP_SYNC_PROMPT: 'group sync', CLAUDE_GROUP_SYNC_PROMPT: 'group sync', ORIGIN_SYNC_PROMPT: 'origin sync',
      PRE_RECLAIM_CHECK_PROMPT: 'check', PRE_RECLAIM_SYNC_PROMPT: 'prepare', SYNC_BACKLOG_ALERT: kind => `alert:${kind}` },
  };
  f.deps = deps;
  f.context = () => ({ configuration: f.configuration, scenes: [{ ...f.scene }],
    fences: [], restartRequests: [], transition: f.transition });
  f.restart = () => { f.lifecycle = new SupervisorLifecycle(deps, { now: () => f.now }); };
  f.check = async (elapsed = 60_000) => {
    f.now += elapsed;
    const context = f.context();
    await f.lifecycle.checkSync(context.scenes, context);
  };
  f.syncs = () => f.controls.filter(row => row.content === 'group sync');
  f.key = JSON.stringify(['group', f.scene.sessionGroup]);
  f.restart();
  return f;
}

for (const mode of ['multi', 'single']) {
  test(`${mode} catches up 500 messages in three requests and returns to ordinary thresholds`, async () => {
    const f = fixture(mode);
    await f.check(0);
    assert.equal(f.syncs().length, 1);
    for (const [count, first, requests] of [[300, 201, 2], [100, 401, 3], [0, null, 3], [5, 501, 3]]) {
      f.count = count; f.first = first;
      await f.check();
      assert.equal(f.syncs().length, requests);
    }
    assert.deepEqual(f.lifecycle.syncProgress.get(f.key), { n0: 100, f0: 401, runId: 'run-a' });
    await f.check(600_000);
    assert.equal(f.syncs().length, 3, 'elapsed interval alone does not request five new messages');
    f.count = 16;
    await f.check();
    assert.equal(f.syncs().length, 4);
    assert.ok(f.rangeReads.every(group => group === (mode === 'single' ? 'origin' : 'a')));
    assert.ok(f.syncs().every(row => row.sessionGroup === (mode === 'single' ? 'origin' : 'a')));
  });

}

