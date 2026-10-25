import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const initUrl = new URL('../../commands/init.js', import.meta.url).href;
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-init-integration-'));
  const root = path.join(home, 'zylos');
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, 'empty-bin'));
  return { home, root };
}
function run({ home, root }, source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: home, ZYLOS_DIR: root,
      CODEX_BIN: path.join(home, 'unavailable-codex'), PATH: path.join(home, 'empty-bin') },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('IF-47/DM-48 default init imports real migration ensure and preserves unreadable records', () => {
  for (const state of ['fresh', 'existing', 'unreadable']) {
    const context = fixture();
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

test('IF-47 init template generator prepares dual hooks and assets report unavailable native trust', () => {
  const context = fixture();
  const instruction = path.join(context.root, 'instructions.md');
  fs.writeFileSync(instruction, '# Fixture instructions\n');
  fs.writeFileSync(path.join(context.root, 'CLAUDE.md'), '# Fixture instructions\n');
  const configPath = path.join(context.root, '.zylos', 'config.json');
  const config = JSON.stringify({ runtime: 'claude', session_mode: 'multi', new_session_threshold: 30, keep: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, config);
  const result = run(context, `
    import { prepareInitRuntimeAssets, syncSettingsHooksAfterTemplateDeploy } from ${JSON.stringify(initUrl)};
    syncSettingsHooksAfterTemplateDeploy();
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
  assert.equal(fs.existsSync(path.join(context.root, '.codex', 'hooks.trust.json')), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), config);
});
