import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const initUrl = new URL('../../commands/init.js', import.meta.url).href;
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p6-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'z');
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, 'empty-bin'));
  return { home, root };
}
function run({ home, root }, source, env = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: home, ZYLOS_DIR: root,
      CODEX_BIN: path.join(home, 'unavailable-codex'), PATH: path.join(home, 'empty-bin'), ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('default init imports real migration ensure and preserves unreadable records', t => {
  for (const state of ['fresh', 'existing', 'unreadable']) {
    const context = fixture(t);
    fs.writeFileSync(path.join(context.root, 'memory', 'references.md'), '# References\n');
    const recordPath = path.join(context.root, '.zylos', 'migrations', 'references-layout-v1.json');
    if (state === 'unreadable') {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      fs.writeFileSync(recordPath, '{broken record');
    }
    const result = run(context, `
      import { ensureInitMemoryMigration } from ${JSON.stringify(initUrl)};
      const warnings = [];
      const options = { freshInstall: ${state === 'fresh'}, warn: text => warnings.push(text) };
      const first = await ensureInitMemoryMigration(options);
      const second = await ensureInitMemoryMigration(options);
      console.log(JSON.stringify({ first, second, warnings }));
    `);
    assert.deepEqual(result.first, result.second);
    assert.equal(result.first.state, state === 'fresh' ? 'done' : state === 'existing' ? 'pending' : 'unreadable');
    const bytes = fs.readFileSync(recordPath, 'utf8');
    if (state === 'unreadable') {
      assert.equal(bytes, '{broken record');
      assert.equal(result.warnings.length, 2);
      assert.match(result.warnings[0], /RECORD_UNREADABLE/);
    } else {
      const record = JSON.parse(bytes);
      assert.equal(record.createdBy, 'init');
      assert.equal(record.evidence?.kind ?? null, state === 'fresh' ? 'fresh_install' : null);
      assert.equal(record.attempts, 0);
      assert.deepEqual(result.warnings, []);
    }
  }
});

// Real init asset/hook generation with private HOME/ZYLOS_DIR and an empty PATH;
// Codex is unavailable, with no real runtime, PM2, tmux or database reached.
// Run for init assets or model-threshold migration changes; unrelated work may
// skip. The official runner isolates PM2_HOME/short TMPDIR; fixtures are removed.
test('init template generator migrates legacy thresholds, prepares dual hooks and reports unavailable native trust', t => {
  const context = fixture(t);
  const instruction = path.join(context.root, 'instructions.md');
  fs.writeFileSync(instruction, '# Fixture instructions\n');
  fs.writeFileSync(path.join(context.root, 'CLAUDE.md'), '# Fixture instructions\n');
  const configPath = path.join(context.root, '.zylos', 'config.json');
  const config = JSON.stringify({ runtime: 'claude', session_mode: 'multi', new_session_threshold: 30, keep: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, config);
  const result = run(context, `
    import { prepareInitRuntimeAssets, syncSettingsHooksAfterTemplateDeploy } from ${JSON.stringify(initUrl)};
    await syncSettingsHooksAfterTemplateDeploy();
    const result = await prepareInitRuntimeAssets({ instruction: () => ${JSON.stringify(instruction)} });
    console.log(JSON.stringify(result));
  `);
  assert.deepEqual(result.completed, ['claude.instructions', 'claude.hooks', 'codex.instructions']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].item, 'codex.hooks');
  assert.match(result.failed[0].message, /unavailable-codex ENOENT/);
  const claude = JSON.parse(fs.readFileSync(path.join(context.root, '.claude', 'settings.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(context.root, '.codex', 'hooks.json'), 'utf8'));
  for (const hooks of [claude.hooks, codex.hooks]) {
    const commands = hooks.SessionStart.flatMap(group => group.hooks.map(hook => hook.command));
    assert.ok(commands.some(command => command.includes('session-start-orchestrator.js')));
  }
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop']) {
    assert.ok(codex.hooks[event].flatMap(group => group.hooks)
      .some(hook => hook.command.endsWith('/hook-activity.js')), `missing nondefault Codex ${event} activity hook`);
  }
  assert.equal(fs.existsSync(path.join(context.root, '.codex', 'hooks.trust.json')), false);
  // Hook sync pins the legacy value to the saved native model. Atomic config
  // writes preserve fields, not the input JSON's whitespace.
  assert.equal(typeof claude.model, 'string');
  assert.ok(claude.model.length > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    ...JSON.parse(config),
    model_rotation_thresholds: { claude: { [claude.model]: 30 } },
  });
});
