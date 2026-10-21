import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { desiredClaudeHooks, syncHooks, supportsStopFailureVersion, detectStopFailureSupport, syncHealthHooksBeforeLaunch } from '../sync-settings-hooks.js';

test('stable Claude versions since StopFailure introduction enable health hooks; unknown and older versions use fallback', () => {
  for (const version of ['2.1.78', '2.1.78 (Claude Code)', '2.1.284', '2.1.300', '2.1.301', '2.1.301 (Claude Code)', '2.2.0']) assert.equal(supportsStopFailureVersion(version), true);
  for (const version of ['', 'garbage 2.1.78', '2.0.999', '2.1.77', '2.1.78-beta', '2.1.301-beta', '3.0.0', '1.9.999']) assert.equal(supportsStopFailureVersion(version), false);
  assert.equal(detectStopFailureSupport({ execFileSyncImpl: () => { throw new Error('missing'); } }), false);
  assert.equal(detectStopFailureSupport({ execFileSyncImpl: (_bin, args, opts) => { assert.deepEqual(args, ['--version']); assert.equal(opts.timeout, 2000); return '2.1.301'; } }), true);
});
test('version detection drives all four health registrations during settings sync', () => {
  const custom = { type: 'command', command: 'node /custom/activity.js' };
  const settings = { hooks: { Stop: [{ hooks: [custom] }] } };
  for (const version of ['2.1.77', '2.1.78', '2.1.284', '2.1.77']) {
    const supported = detectStopFailureSupport({ execFileSyncImpl: () => `${version} (Claude Code)` });
    syncHooks(settings, {}, { desiredHooks: desiredClaudeHooks({ stopFailureSupported: supported }), log: () => {} });
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure']) {
      const registered = (settings.hooks[event] || []).some(group => (group.hooks || []).some(hook => hook.command?.includes('hook-health.js')));
      assert.equal(registered, version !== '2.1.77', `${version}: ${event}`);
    }
    assert.ok(settings.hooks.Stop.some(group => group.hooks.includes(custom)));
  }
});
test('managed synchronous health hooks converge without replacing custom hooks', () => {
  const custom = { type: 'command', command: 'node /custom/failure.js', timeout: 20 };
  const settings = { hooks: { StopFailure: [{ hooks: [custom] }] } };
  const desired = desiredClaudeHooks({ stopFailureSupported: true });
  syncHooks(settings, {}, { desiredHooks: desired, log: () => {} });
  const hook = settings.hooks.StopFailure[0].hooks.find(value => value.command.includes('hook-health.js'));
  assert.equal(hook.async, false);
  assert.equal(hook.timeout, 5);
  assert.ok(settings.hooks.Stop[0].hooks.some(value => value.command.includes('hook-health.js') && value.async === false));
  assert.deepEqual(settings.hooks.StopFailure[0].hooks[0], custom);
  hook.async = true;
  assert.equal(syncHooks(settings, {}, { desiredHooks: desired, log: () => {} }).updated, 1);
  assert.equal(hook.async, false);
  assert.deepEqual(syncHooks(settings, {}, { desiredHooks: desired, log: () => {} }), { added: 0, updated: 0, removed: 0 });
  syncHooks(settings, {}, { desiredHooks: desiredClaudeHooks({ stopFailureSupported: false }), log: () => {} });
  assert.deepEqual(settings.hooks.StopFailure[0].hooks, [custom]);
});
test('launch-time refresh notices a CLI-only upgrade/downgrade and is idempotent without restarts', t => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-sync-'));
  t.after(() => fs.rmSync(zylosDir, { recursive: true, force: true }));
  const script = path.join(zylosDir, '.claude/skills/activity-monitor/scripts/hook-health.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '// fixture');
  const settingsPath = path.join(zylosDir, '.claude/settings.json');
  const custom = { type: 'command', command: 'node /custom/prompt.js', async: true };
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'existing', hooks: { UserPromptSubmit: [{ hooks: [custom] }] } }));
  assert.equal(syncHealthHooksBeforeLaunch({ zylosDir, supported: true }).changed, true);
  assert.equal(syncHealthHooksBeforeLaunch({ zylosDir, supported: true }).changed, false);
  let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.model, 'existing');
  assert.deepEqual(settings.hooks.UserPromptSubmit[0].hooks[0], custom);
  assert.equal(settings.hooks.StopFailure[0].hooks[0].async, false);
  assert.ok(settings.hooks.Stop[0].hooks.some(value => value.command.includes('hook-health.js')));
  assert.equal(syncHealthHooksBeforeLaunch({ zylosDir, supported: false }).changed, true);
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.hooks.StopFailure, undefined);
  assert.equal(settings.hooks.Stop, undefined);
  assert.deepEqual(settings.hooks.UserPromptSubmit[0].hooks, [custom]);
});
