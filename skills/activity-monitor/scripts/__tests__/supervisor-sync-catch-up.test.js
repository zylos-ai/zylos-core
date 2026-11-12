import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';

// Unit fixture: all database, runtime and marker observations are in memory.
// No processes, timers, files, live database, PM2 or tmux are started.
function fixture(mode = 'multi', configuration = {}) {
  const f = {
    now: 2_000_000, count: 500, first: 1, lastActivity: 0,
    scene: { sessionGroup: mode === 'single' ? null : 'a', present: true, ready: true,
      runtime: 'claude', runId: 'run-a', sessionId: 'session-a', runDir: '/isolated/run',
      createdAt: 0, state: 'idle', idleSince: 0, processRunning: true, usagePercent: 0 },
    configuration: { mode, syncThreshold: 15, ...configuration },
    marker: { held: false, stale: false }, controls: [], markerReads: [],
    backlog: { total: 0, groups: [] }, rangeReads: [], transition: null,
  };
  const range = () => ({ count: f.count, firstConversationId: f.count ? f.first : null,
    firstAt: f.count ? f.now : null });
  const deps = {
    db: {
      getModeTransition: () => f.transition,
      listDrainFences: () => [],
      getUnsummarizedRange: group => { f.rangeReads.push(group); return range(); },
      getGlobalUnsummarizedRange: () => { f.rangeReads.push('*'); return range(); },
      getOriginSyncBacklog: () => f.backlog,
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
    prompts: { GROUP_SYNC_PROMPT: 'group sync', ORIGIN_SYNC_PROMPT: 'origin sync',
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
  f.key = JSON.stringify([mode === 'single' ? 'global' : 'group', f.scene.sessionGroup]);
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
    assert.ok(f.rangeReads.every(group => group === (mode === 'single' ? '*' : 'a')));
    assert.ok(f.syncs().every(row => row.sessionGroup === (mode === 'single' ? null : 'a')));
  });

  test(`${mode} does not catch up a batch of 150 messages`, async () => {
    const f = fixture(mode); f.count = 150;
    await f.check(0);
    f.count = 5; f.first = 146;
    await f.check();
    assert.equal(f.syncs().length, 1, 'partial progress from a small batch cannot start catch-up');
    f.count = 0;
    await f.check();
    assert.equal(f.syncs().length, 1);
  });
}

test('checkpoint failure with unchanged first message waits for the ordinary interval', async () => {
  const f = fixture();
  await f.check(0);
  f.count = 300;
  await f.check();
  await f.check();
  assert.equal(f.syncs().length, 1);
  assert.equal(f.markerReads.length, 1, 'unchanged coverage does not reach marker or enqueue checks');
  await f.check(480_000);
  assert.equal(f.syncs().length, 2);
});

test('checkpoint progress continues catch-up independently of a failed state commit', async () => {
  const f = fixture();
  // A successful checkpoint followed by a failed state commit advances this
  // range but supplies no state-commit result to the supervisor interface.
  await f.check(0);
  f.count = 300; f.first = 201;
  await f.check();
  f.count = 100; f.first = 401;
  await f.check();
  f.count = 0;
  await f.check();
  assert.equal(f.syncs().length, 3);
});

test('TTL preparation preserves the catch-up record and cancellation resumes progress', async () => {
  const f = fixture();
  await f.check(0);
  const previous = f.lifecycle.syncProgress.get(f.key);
  f.count = 300; f.first = 201;
  await f.lifecycle.checkTtl(f.scene, f.context());
  assert.equal(f.controls.at(-1).content, 'prepare');
  assert.equal(f.lifecycle.ttlPreparation.has('a'), true);
  assert.equal(f.lifecycle.syncProgress.get(f.key), previous, 'TTL enqueue is outside progress recording');
  await f.check();
  assert.equal(f.syncs().length, 1);
  f.lastActivity = f.now + 1;
  await f.lifecycle.checkTtl(f.scene, f.context());
  assert.equal(f.lifecycle.ttlPreparation.has('a'), false);
  await f.check();
  assert.equal(f.syncs().length, 2);
  assert.deepEqual(f.lifecycle.syncProgress.get(f.key), { n0: 300, f0: 201, runId: 'run-a' });
});

test('TTL preparation leaves ordinary Sync conditions intact', async () => {
  const f = fixture();
  await f.check(0);
  f.count = 300; f.first = 201;
  await f.lifecycle.checkTtl(f.scene, f.context());
  await f.check(600_000);
  assert.equal(f.lifecycle.ttlPreparation.has('a'), true);
  assert.equal(f.syncs().length, 2, 'ordinary threshold plus interval still requests Sync');
});

test('replacement run waits for ordinary startup request before establishing its own catch-up record', async () => {
  const f = fixture('multi', { syncThreshold: 1000 });
  await f.check(0);
  f.scene.runId = 'replacement'; f.count = 300; f.first = 201;
  await f.check();
  assert.equal(f.syncs().length, 1, 'new run cannot reuse old progress to bypass the interval');
  await f.check(540_000);
  assert.equal(f.syncs().length, 2, 'new run startup condition requests below the configured threshold');
  assert.deepEqual(f.lifecycle.syncProgress.get(f.key), { n0: 300, f0: 201, runId: 'replacement' });
  f.count = 100; f.first = 401;
  await f.check();
  assert.equal(f.syncs().length, 3, 'new run catches up below both interval and due threshold');
});

test('supervisor restart drops progress and starts from ordinary conditions', async () => {
  const f = fixture('multi', { syncThreshold: 1000 });
  await f.check(0);
  f.count = 300; f.first = 201;
  f.restart();
  assert.equal(f.lifecycle.syncProgress.size, 0);
  assert.equal(f.lifecycle.syncSent.size, 0);
  await f.check();
  assert.equal(f.syncs().length, 2, 'fresh startup permits one request below threshold');
  assert.deepEqual(f.lifecycle.syncProgress.get(f.key), { n0: 300, f0: 201, runId: 'run-a' });
  f.count = 100; f.first = 401;
  await f.check();
  assert.equal(f.syncs().length, 3);
});

test('catch-up follows the existing batch limit and requires strictly greater previous backlog', async () => {
  for (const [limit, catchesUp] of [[100, true], [150, false], [200, false]]) {
    const f = fixture('multi', { syncBatchLimit: limit }); f.count = 150;
    await f.check(0);
    f.count = 10; f.first = 141;
    await f.check();
    assert.equal(f.syncs().length, catchesUp ? 2 : 1, `limit ${limit}`);
  }
});

test('catch-up retains marker checks and only stale held markers allow enqueue', async () => {
  const f = fixture();
  await f.check(0);
  const previous = f.lifecycle.syncProgress.get(f.key);
  f.count = 300; f.first = 201; f.marker = { held: true, stale: false };
  await f.check();
  assert.equal(f.syncs().length, 1);
  assert.equal(f.lifecycle.syncProgress.get(f.key), previous);
  f.marker.stale = true;
  await f.check();
  assert.equal(f.syncs().length, 2);
  assert.equal(f.markerReads.at(-1).currentRunId, 'run-a');
});

test('failed enqueue and changed authority leave the previous request record untouched', async () => {
  const f = fixture();
  await f.check(0);
  const previous = f.lifecycle.syncProgress.get(f.key), sentAt = f.lifecycle.syncSent.get(f.key);
  f.count = 300; f.first = 201; f.writeError = Object.assign(new Error('private fixture failure'), { code: 'DB_BUSY' });
  await assert.rejects(f.check(), { code: 'DB_BUSY' });
  assert.equal(f.syncs().length, 1);
  assert.equal(f.lifecycle.syncProgress.get(f.key), previous);
  assert.equal(f.lifecycle.syncSent.get(f.key), sentAt);
  f.writeError = null;
  f.deps.db.getModeTransition = () => ({ state: 'active' });
  await f.check();
  assert.equal(f.syncs().length, 1);
  assert.equal(f.lifecycle.syncProgress.get(f.key), previous);
  f.deps.db.getModeTransition = () => null;
  await f.check();
  assert.equal(f.syncs().length, 2);
});

test('runtime replacement during final revalidation blocks catch-up enqueue', async () => {
  const f = fixture();
  await f.check(0);
  const previous = f.lifecycle.syncProgress.get(f.key);
  f.count = 300; f.first = 201;
  f.deps.observeGroup = group => ({ ...f.scene, sessionGroup: group, runId: 'replacement' });
  await f.check();
  assert.equal(f.syncs().length, 1);
  assert.equal(f.lifecycle.syncProgress.get(f.key), previous);
});

test('Origin Sync retains its minimum interval and never records catch-up progress', async () => {
  const f = fixture();
  const origin = { sessionGroup: 'origin', runId: 'origin-run', runDir: '/isolated/origin' };
  const checkOrigin = async count => f.lifecycle.syncScope(origin, 'origin', {
    count, nonempty: count > 0, firstAt: f.now, firstConversationId: f.first,
  }, f.context());
  await checkOrigin(500);
  assert.equal(f.controls.length, 1);
  assert.equal(f.controls[0].content, 'origin sync');
  assert.equal(f.lifecycle.syncProgress.size, 0);
  f.now += 60_000; f.first = 201;
  await checkOrigin(300);
  assert.equal(f.controls.length, 1);
  f.now += 540_000;
  await checkOrigin(300);
  assert.equal(f.controls.length, 2);
  assert.equal(f.lifecycle.syncProgress.size, 0);
});
