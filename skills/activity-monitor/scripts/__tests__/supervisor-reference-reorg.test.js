import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';

// Unit fixture: queue, runtime, marker and old-file observations are in
// memory. No files, timers, children, live database, tmux or PM2 are used.
function fixture(mode = 'multi', kind = 'origin') {
  let now = 2_000_000;
  const group = kind === 'origin' ? 'origin' : 'a';
  const scene = { sessionGroup: group, present: true, ready: true, runtime: 'claude',
    runId: 'reference-run', sessionId: 'reference-session', runDir: '/isolated/reference-run',
    state: 'idle', processRunning: true, usagePercent: 0, createdAt: 0, idleSince: 0 };
  const f = { controls: [], events: [], errors: [], prepareCalls: 0, shouldPropose: true,
    transition: null, marker: { held: false, stale: false } };
  const deps = {
    db: {
      listRunEndings: () => [],
      getLastCompletedModeTransition: () => null,
      getModeTransition: () => f.transition,
      listDrainFences: () => [],
      getLastActivity: () => 0,
      getUnsummarizedRange: () => ({ count: 0, firstAt: null }),
      getOriginSyncBacklog: () => ({ total: f.range.count,
        groups: [{ count: f.range.count, firstAt: f.range.firstAt, pendingCheckpoints: 0 }] }),
      insertControl: (content, options) => {
        f.events.push(content === 'reference proposal' ? 'proposal' : 'sync');
        if (content === 'reference proposal' && f.proposalError) throw f.proposalError;
        const row = { content, ...options };
        f.controls.push(row);
        return { id: f.controls.length, ...row };
      },
    },
    requests: { read: () => [] },
    observeGroup: () => ({ ...scene }),
    groupRunDir: () => scene.runDir,
    bindTarget: () => ({ expectedRunId: scene.runId }),
    readSyncMarker: () => f.marker,
    prepareReferenceReorg: () => {
      f.prepareCalls += 1;
      if (f.prepareError) throw f.prepareError;
      f.events.push(f.shouldPropose ? 'old-files-present' : 'old-files-absent');
      return f.shouldPropose;
    },
    prompts: { REFERENCE_REORG_PROMPT: 'reference proposal', ORIGIN_SYNC_PROMPT: 'origin sync',
      GROUP_SYNC_PROMPT: 'group sync', SYNC_BACKLOG_ALERT: () => 'backlog alert',
      PRE_RECLAIM_CHECK_PROMPT: 'reclaim check', PRE_RECLAIM_ORIGIN_SYNC_PROMPT: 'reclaim origin sync' },
    reportError: (cause, context) => f.errors.push({ cause, context }),
  };
  f.deps = deps;
  f.lifecycle = new SupervisorLifecycle(deps, { now: () => now });
  f.context = { configuration: { mode, hotTtlSeconds: 1800 }, scenes: [{ ...scene }], fences: [], restartRequests: [], transition: null };
  f.range = { count: 60, nonempty: true, firstAt: now, firstConversationId: 1 };
  f.run = () => f.lifecycle.syncScope(scene, kind, f.range, f.context);
  f.periodic = () => f.lifecycle.checkSync([scene], f.context);
  f.scene = scene;
  f.restart = () => { f.lifecycle = new SupervisorLifecycle(deps, { now: () => now }); };
  f.advance = milliseconds => { now += milliseconds; };
  f.expectedSync = { content: kind === 'origin' ? 'origin sync' : 'group sync',
    sessionGroup: group, priority: 2, appendAckSuffix: false,
    ...(kind === 'origin' ? {} : { ackDeadlineAt: Math.floor((now + 300_000) / 1000), createdAt: Math.floor(now / 1000) }) };
  return f;
}

test('proposal enqueue failure is logged and does not suppress the ordinary Sync control', async () => {
  const f = fixture();
  f.proposalError = Object.assign(new Error('proposal queue failed'), { code: 'QUEUE_FAILED' });
  await f.run();
  assert.equal(f.prepareCalls, 1);
  assert.deepEqual(f.events, ['old-files-present', 'proposal', 'sync']);
  assert.deepEqual(f.controls, [f.expectedSync]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].cause, f.proposalError);
  assert.equal(f.errors[0].context.phase, 'reference-reorganization');
});

