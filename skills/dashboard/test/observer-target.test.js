import test from 'node:test';
import assert from 'node:assert/strict';
import { createObserverTargets, validObserverBinding } from '../src/lib/observer-target.js';
import * as paths from '../../../cli/lib/session-group-paths.js';

function fixture() {
  let mode = 'multi';
  const groups = new Map();
  const targets = createObserverTargets({ load: async file => file === 'config.js'
    ? { readSessionMode: () => ({ mode }) }
    : file === 'session-group-paths.js' ? paths : { readLiveIdentity: async group => groups.get(group) } });
  return { ...targets, groups, setMode(value) { mode = value; } };
}
const live = (group, runtime = 'codex') => ({ present: true, ready: true, runId: `run-${group}`, runtime,
  tmuxName: group === null ? `${runtime}-main` : paths.tmuxNameForGroup(group) });

test('managed group target resolution works while Origin sleeps and rejects foreign names', async () => {
  const f = fixture();
  for (const group of ['telegram:42', 'lark:team.topic']) f.groups.set(group, live(group));
  await assert.rejects(f.resolve(), { code: 'agent_session_unavailable' });
  for (const group of f.groups.keys()) {
    const selected = await f.resolve(group);
    assert.equal(selected.sessionGroup, group);
    assert.equal(selected.tmuxName, paths.tmuxNameForGroup(group));
    assert(await validObserverBinding(selected, selected.tmuxName, selected.runId));
    assert.equal(await validObserverBinding(selected, 'zylos-group-unmanaged', selected.runId), false);
    f.groups.set(group, { ...live(group), tmuxName: 'other-session' });
    await assert.rejects(f.resolve(group), { code: 'agent_session_unavailable' });
  }
  for (const group of ['', 'invalid group', 123, {}, '../origin']) await assert.rejects(f.resolve(group), { code: 'target_mismatch' });
});

test('single mode preserves its sole Origin target and rejects other groups', async () => {
  const f = fixture(); f.setMode('single'); f.groups.set(null, live(null, 'claude'));
  for (const group of [undefined, null, 'origin']) assert.equal((await f.resolve(group)).tmuxName, 'claude-main');
  await assert.rejects(f.resolve('telegram:42'), { code: 'target_mismatch' });
  f.groups.set(null, { ...live(null), tmuxName: 'zylos-group-origin' });
  const modern = await f.resolve();
  assert.equal(modern.tmuxName, 'zylos-group-origin');
  assert(await validObserverBinding(modern, modern.tmuxName, modern.runId));
  f.groups.set(null, { ...live(null), ready: false });
  await assert.rejects(f.resolve(), { code: 'agent_session_unavailable' });
});
