import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { groupRunDir } from '../session-group-paths.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('ZYLO-85: activity and migration entrypoints execute through aliases and stay inert on import', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-alias-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const alias = path.join(directory, 'alias');
  fs.symlinkSync(root, alias, 'dir');
  const env = { ...process.env, HOME: directory, ZYLOS_DIR: path.join(directory, 'zylos'),
    ZYLOS_PACKAGE_ROOT: root, ZYLOS_SESSION_GROUP: 'a2test:alias', ZYLOS_RUN_ID: 'alias-run',
    ZYLOS_MODEL_CONFIG: JSON.stringify({ runtime: 'codex' }) };
  delete env.HOOK_ACTIVITY_DISABLE_MAIN;
  const run = (script, args = [], input = '') => spawnSync(process.execPath, [script, ...args], {
    env, input, encoding: 'utf8', timeout: 10000,
  });
  const activity = 'skills/activity-monitor/scripts/hook-activity.js';
  const events = path.join(groupRunDir(env.ZYLOS_SESSION_GROUP, env), 'events.jsonl');
  const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'alias-session' });
  await t.test('activity alias writes the same prompt event as the canonical path', () => {
    for (const base of [root, alias]) {
      const before = fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').length : 0;
      const result = run(path.join(base, activity), [], payload);
      assert.equal(result.status, 0, result.stderr);
      const rows = fs.readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.length, before + 1);
      assert.equal(rows.at(-1).event, 'prompt');
      assert.equal(rows.at(-1).session_id, 'alias-session');
    }
  });
  const migration = 'skills/zylos-memory/scripts/memory-migration.js';
  await t.test('migration alias executes valid input and rejects malformed input', () => {
    for (const base of [root, alias]) {
      const script = path.join(base, migration);
      const valid = run(script, ['ensure', '--id', 'references-layout-v1', '--created-by', 'init', '--json']);
      assert.equal(valid.status, 0, valid.stderr);
      assert.equal(JSON.parse(valid.stdout).data.state, 'pending');
      const invalid = run(script, ['apply', '--id', 'references-layout-v1', '--json']);
      assert.equal(invalid.status, 1, invalid.stderr);
      assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_INPUT');
    }
  });
  await t.test('imports do not execute either CLI body', () => {
    const before = fs.readFileSync(events);
    for (const relative of [activity, migration]) {
      const result = run('--input-type=module', ['-e', `await import(${JSON.stringify(pathToFileURL(path.join(alias, relative)).href)});`], payload);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
    assert.deepEqual(fs.readFileSync(events), before);
  });
});
