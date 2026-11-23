import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';

// Real lifecycle methods with in-memory observations only: no processes,
// timers, database files, tmux, PM2 or network. Run for Sync trigger changes.
function fixture(mode = 'multi', configuration = {}) {
  const start = Date.parse('2026-11-13T02:00:00Z');
  const f = { now: start + 120000, firstAt: '2026-11-13 02:00:01', count: 2,
    controls: [], errors: [], events: [], held: false };
  f.scene = { sessionGroup: mode === 'single' ? null : 'a', present: true, ready: true,
    runtime: 'claude', runId: 'run-a', sessionId: 'session-a', createdAt: start,
    runDir: '/isolated/run', usagePercent: 0 };
  const range = () => ({ count: f.count, firstAt: f.firstAt, firstConversationId: 1 });
  const db = {
    getModeTransition: () => null, listDrainFences: () => [],
    getUnsummarizedRange: range, getGlobalUnsummarizedRange: range,
    getOriginSyncBacklog: () => ({ total: 0, groups: [] }),
    insertControl: (content, options) => { f.controls.push({ content, ...options }); },
  };
  f.context = { configuration: { mode, legacy: mode === 'single', ...configuration }, scenes: [f.scene], fences: [], restartRequests: [], transition: null };
  f.lifecycle = new SupervisorLifecycle({ db, requests: { read: () => [] },
    observeGroup: group => f.context.scenes.find(scene => scene.sessionGroup === group),
    readSyncMarker: () => ({ held: f.held, stale: false }), groupRunDir: () => '/isolated/origin',
    prepareReferenceReorg: () => false, diagnostic: event => f.events.push(event),
    reportError: (cause, context) => f.errors.push({ cause, context }),
    prompts: { GROUP_SYNC_PROMPT: 'sync', ORIGIN_SYNC_PROMPT: 'origin', SYNC_BACKLOG_ALERT: () => 'alert',
      REFERENCE_REORG_PROMPT: 'reference proposal' },
  }, { now: () => f.now });
  f.check = async () => { await f.lifecycle.checkSync(f.context.scenes, f.context); f.now += 600000; };
  f.syncs = () => f.controls.filter(row => row.content === 'sync');
  f.key = JSON.stringify([mode === 'single' ? 'global' : 'group', f.scene.sessionGroup]);
  f.start = start;
  return f;
}

test('fresh messages retain threshold, longest wait and marker gates', async () => {
  const threshold = fixture(); threshold.count = 15; await threshold.check(); assert.equal(threshold.syncs().length, 0);
  threshold.count = 16; await threshold.check(); assert.equal(threshold.syncs().length, 1);
  const lag = fixture(); lag.now = lag.start + 21600000 + 1000; await lag.check(); assert.equal(lag.syncs().length, 1);
  const marker = fixture(); marker.count = 16; marker.held = true; await marker.check();
  assert.equal(marker.syncs().length, 0); assert.equal(marker.lifecycle.syncSent.has(marker.key), false);
});

