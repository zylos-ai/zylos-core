import assert from 'node:assert/strict';
import test from 'node:test';
import { desiredClaudeHooks, desiredSessionStartHooks, syncHooks,
  supportsSubagentHooksVersion, detectSubagentHooksSupport } from '../sync-runtime-hooks.js';

const activity = hook => hook.command?.endsWith('/skills/activity-monitor/scripts/hook-activity.js');

test('session start records activity without changing health or injection entries', () => {
  const options = { zylosDir: '/isolated-instance', existsSync: () => true };
  const desired = desiredClaudeHooks({ ...options, subagentHooksSupported: true });
  assert.deepEqual(desired.SessionStart.map(group => group.matcher), ['startup', 'clear', 'compact']);
  for (const { hooks } of desired.SessionStart) {
    assert.match(hooks[0].command, /hook-health\.js$/);
    assert.equal(hooks[0].async, false);
    assert.deepEqual(hooks.slice(1, -1), desiredSessionStartHooks(options));
    assert.equal(hooks.filter(activity).length, 1);
    assert.equal(activity(hooks.at(-1)), true);
    assert.equal(hooks.at(-1).async, true);
    assert.equal(hooks.at(-1).timeout, 5);
  }
  for (const event of ['SubagentStart', 'SubagentStop']) {
    assert.deepEqual(desired[event], [{ hooks: [desired.SessionStart[0].hooks.at(-1)] }]);
  }
});

test('subagent hooks require a verified version with both lifecycle events', () => {
  for (const version of ['2.0.43', '2.0.43 (Claude Code)', '2.1.318', '2.2.0', '3.0.0']) {
    assert.equal(supportsSubagentHooksVersion(version), true, version);
  }
  for (const version of ['', 'unknown', '1.9.999', '2.0.42', '2.0.43-beta', 'prefix 2.0.43']) {
    assert.equal(supportsSubagentHooksVersion(version), false, version);
  }
  assert.equal(detectSubagentHooksSupport({ execFileSyncImpl: () => { throw Error('not installed'); } }), false);
  assert.equal(detectSubagentHooksSupport({ binary: 'isolated-claude', execFileSyncImpl: (binary, args, options) => {
    assert.equal(binary, 'isolated-claude'); assert.deepEqual(args, ['--version']);
    assert.equal(options.timeout, 2000); return '2.1.318 (Claude Code)';
  } }), true);
  const unsupported = desiredClaudeHooks({ subagentHooksSupported: false });
  assert.equal(unsupported.SubagentStart, undefined);
  assert.equal(unsupported.SubagentStop, undefined);
  assert.equal(unsupported.SessionStart.every(group => group.hooks.some(activity)), true);
});

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
