import assert from 'node:assert/strict';
import test from 'node:test';
import { desiredClaudeHooks, syncHooks } from '../runtime/claude/hooks.js';

const activity = hook => hook.command?.endsWith('/skills/activity-monitor/scripts/hook-activity.js');

test('sync backfills missing activity hooks, preserves custom hooks and converges', () => {
  const desired = desiredClaudeHooks({ zylosDir: process.env.ZYLOS_DIR, subagentHooksSupported: true });
  const custom = { type: 'command', command: 'node /user/session-hook.js' };
  const installed = { hooks: { ...structuredClone(desired), SessionStart: desired.SessionStart.map(group => ({ ...group,
    hooks: [...group.hooks.filter(hook => !activity(hook)), { ...custom }],
  })), SubagentStart: [{ matcher: 'Explore', hooks: [{ ...custom }] }],
  SubagentStop: [{ hooks: [{ ...custom }] }] } };
  const sync = supported => syncHooks(installed, {}, { zylosDir: process.env.ZYLOS_DIR,
    desiredHooks: desiredClaudeHooks({ zylosDir: process.env.ZYLOS_DIR, subagentHooksSupported: supported }), log: () => {} });
  assert.deepEqual(sync(true), { added: 5, updated: 0, removed: 0 });
  for (const group of installed.hooks.SessionStart) {
    assert.equal(group.hooks.filter(activity).length, 1);
    assert.ok(group.hooks.some(hook => hook.command === custom.command));
    assert.deepEqual(group.hooks.filter(hook => !activity(hook)),
      [...desired.SessionStart.find(item => item.matcher === group.matcher).hooks.filter(hook => !activity(hook)), custom]);
  }
  assert.deepEqual(sync(true), { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(sync(false), { added: 0, updated: 0, removed: 2 });
  assert.deepEqual(installed.hooks.SubagentStart, [{ matcher: 'Explore', hooks: [custom] }]);
  assert.deepEqual(installed.hooks.SubagentStop, [{ hooks: [custom] }]);
});
