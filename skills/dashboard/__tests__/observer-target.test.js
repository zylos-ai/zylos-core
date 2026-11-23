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
  tmuxName: paths.tmuxNameForGroup(group ?? 'origin') });

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
