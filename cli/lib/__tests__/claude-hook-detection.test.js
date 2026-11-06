import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Configuration integration: fixed-version executable, real synchronization and
// runtime readiness. Run for capability detection or hook-readiness changes;
// skip rendering-only changes. No real Claude, model, tmux, PM2 or network calls.
// Owned HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private tmux directory are read back
// before product import. The existing detector bounds children to 2s; cleanup
// restores environment and removes fixture files even if an assertion fails.
test('default Claude hook detection and readiness follow the configured binary version', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-detect-'));
  const env = { HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux'),
    CLAUDE_BIN: path.join(root, 'claude-version'), TMUX: undefined };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(process.env[key]).startsWith(root + path.sep), key);
  }
  const { syncRuntimeHooks } = await import('../sync-runtime-hooks.js');
  const { runtimeHooksReady } = await import('../../commands/runtime.js');
  const settingsPath = path.join(env.ZYLOS_DIR, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(path.join(env.ZYLOS_DIR, 'CLAUDE.md'), 'fixture instructions\n');
  const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const [version, supported] of [['2.0.43', true], ['2.0.42', false]]) {
    await t.test(`Claude ${version} default synchronization and readiness`, async () => {
      fs.writeFileSync(env.CLAUDE_BIN, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== '--version') process.exit(9);\nconsole.log('${version} (Claude Code)');\n`, { mode: 0o755 });
      assert.ok(fs.realpathSync(process.env.CLAUDE_BIN).startsWith(root + path.sep));
      // Do not inject subagentHooksSupported: exercise the production default.
      syncRuntimeHooks({ zylosDir: env.ZYLOS_DIR, log: () => {} });
      const settings = read();
      for (const event of ['SubagentStart', 'SubagentStop']) {
        assert.equal(settings.hooks[event]?.some(group => group.hooks.some(hook => /hook-activity\.js$/.test(hook.command))) ?? false, supported, event);
      }
      assert.equal((await runtimeHooksReady('claude')).ready, true);
      // Readiness must reject stale settings in both version directions.
      const stale = structuredClone(settings);
      if (supported) delete stale.hooks.SubagentStart;
      else stale.hooks.SubagentStart = [{ hooks: [{ type: 'command',
        command: `node ${env.ZYLOS_DIR}/.claude/skills/activity-monitor/scripts/hook-activity.js`, async: true, timeout: 5 }] }];
      fs.writeFileSync(settingsPath, JSON.stringify(stale));
      assert.equal((await runtimeHooksReady('claude')).ready, false);
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      assert.equal((await runtimeHooksReady('claude')).ready, true);
    });
  }
});
