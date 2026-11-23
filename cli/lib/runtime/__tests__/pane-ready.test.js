import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { paneReady } = await import('../session-target.js');

const ready = (sessionId, publisher = {}) => ({ runId: 'r1', sessionId, ts: 1, startupControlIds: [], ...publisher });

test('READY from another process of the run keeps the last READY of the pane process', () => {
  const group = 'ready-unit';
  const options = { runId: 'r1', runtime: 'claude', panePid: 100, readInfo: pid => (pid === 100 ? { start: '500', comm: 'claude' } : null) };
  const own = ready('main-1', { runtimePid: 100, runtimeStart: '500', runtimeParentPid: 1 });
  assert.equal(paneReady(group, own, options), own);
  const child = ready('child-1', { runtimePid: 222, runtimeStart: '900', runtimeParentPid: 100, runtimeParentStart: '500' });
  assert.equal(paneReady(group, child, options), own);
  const reused = ready('child-2', { runtimePid: 100, runtimeStart: '501', runtimeParentPid: 1 });
  assert.equal(paneReady(group, reused, options), own);

  // /clear in the same process publishes a new session that is accepted.
  const cleared = ready('main-2', { runtimePid: 100, runtimeStart: '500', runtimeParentPid: 1 });
  assert.equal(paneReady(group, cleared, options), cleared);
  // A new pane process (restart) is accepted for its own run.
  const restarted = { ...ready('main-3', { runtimePid: 300, runtimeStart: '700', runtimeParentPid: 1 }), runId: 'r2' };
  assert.equal(paneReady(group, restarted, { ...options, runId: 'r2', panePid: 300, readInfo: () => ({ start: '700', comm: 'claude' }) }), restarted);
  // A child READY in that run never falls back to the previous run's READY.
  assert.equal(paneReady('ready-unit-2', { ...child, runId: 'r2' }, { ...options, runId: 'r2', panePid: 300, readInfo: () => ({ start: '700', comm: 'claude' }) }), null);
});
