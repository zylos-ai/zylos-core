import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { batchFixture } from './helpers/session-batch-fixture.js';
import { startCodexWrapper } from './helpers/codex-wrapper-ready.js';

const options = { freshnessMs: 60000 };

// Boundary: batch observation accepts a READY file from the direct child of a real tmux launcher pane.
// Run after batch READY, launcher identity, or process ownership changes; skip for UI-only changes.
test('batch target accepts READY published by the native child of a Codex launcher pane', { timeout: 20000 }, async t => {
  const { root, reader, tmux } = batchFixture(t);
  const group = 'batch-wrapper';
  const ready = await startCodexWrapper({
    tmux, tmuxName: `zylos-group-${group}`, runId: 'batch-wrapper-run',
    readyFile: path.join(root, 'activity-monitor', 'session-groups', group, 'current-session.json'),
  });
  const target = (await reader.readSessionTargets([group])).get(group);
  assert.equal(target.runtime, 'codex');
  assert.equal(target.ready, true);
  assert.equal(target.runtimeSessionId, ready.sessionId);
});

// Boundary: real tmux environment/format decoding and local status/usage binding.
// Run after reader, tmux observation/parser or session identity changes; skip for UI-only changes.
test('batch states match individual reads for ready, missing and pane-only sessions', { timeout: 20000 }, async t => {
  const f = batchFixture(t);
  f.add('origin', { model: '模型\\$HOME\nline\tvalue' });
  f.add('worker');
  f.add('pane-only', { paneOnly: true });
  f.tmux('new-session', '-d', '-s', 'unrelated', 'sleep', '600');
  const groups = ['origin', 'worker', 'missing', 'pane-only'];
  const batch = await f.reader.readSessionStates(groups, options);
  assert.equal(batch.size, groups.length);
  for (const group of groups) {
    const individual = await f.reader.readSessionState(group, options);
    const { identity, status, usage } = batch.get(group);
    assert.deepEqual({ identity, status, usage }, individual);
  }
  assert.equal(batch.get('origin').usage.valid, true);
  assert.equal(batch.get('missing').status.reason, 'not_running');
  assert.equal(batch.get('pane-only').status.reason, 'starting');
  const identities = await f.reader.readLiveIdentities(groups);
  for (const group of groups) assert.deepEqual(identities.get(group), batch.get(group).identity);
  const listed = await f.reader.readLiveIdentities();
  assert.equal(listed.size, 3);
  assert.equal(listed.has('unrelated'), false);
});

// Boundary: mutation is injected immediately before the second real list-panes,
// after the local sample. No product source is rewritten and both observations are real.
// Run after reader identity validation or tmux generation changes; skip for UI-only changes.
for (const mutation of ['run identity', 'ready identity', 'pane identity', 'session identity', 'server replacement', 'session disappearance']) {
  test(`batch rejects samples after ${mutation} changes`, { timeout: 20000 }, async t => {
    const f = batchFixture(t);
    f.add('origin');
    if (mutation === 'session identity') f.add('keeper');
    let observations = 0;
    f.setBeforeCommand(async argv => {
      if (argv[0] !== 'list-panes' || ++observations !== 2) return;
      if (mutation === 'run identity') f.tmux('set-environment', '-t', 'zylos-group-origin', 'ZYLOS_RUN_ID', 'new-run');
      if (mutation === 'ready identity') f.write('origin', 'current-session.json', { runId: 'run-origin', sessionId: 'new-session', ts: Date.now(), startupControlIds: [] });
      if (mutation === 'pane identity') {
        const oldPane = f.tmux('display-message', '-p', '-t', 'zylos-group-origin:', '#{pane_id}');
        f.tmux('split-window', '-d', '-t', oldPane, 'sleep', '600');
        f.tmux('kill-pane', '-t', oldPane);
      }
      if (mutation === 'session identity') {
        f.tmux('kill-session', '-t', 'zylos-group-origin');
        f.add('origin');
      }
      if (mutation === 'session disappearance') f.tmux('kill-session', '-t', 'zylos-group-origin');
      if (mutation === 'server replacement') {
        f.tmux('kill-server');
        await f.waitForServerExit();
        f.add('origin');
      }
    });
    const result = (await f.reader.readSessionStates(['origin'], options)).get('origin');
    assert.equal(observations, 2);
    assert.equal(result.status.valid, false);
    assert.equal(result.usage.valid, false);
    assert.equal(result.status.reason, 'identity_changed');
    assert.equal(result.usage.reason, 'identity_changed');
    assert.equal(result.target.ready, false);
    assert.equal(result.target.runtime, 'unknown');
    assert.equal(result.observationError.code, 'TARGET_GONE');
  });
}
