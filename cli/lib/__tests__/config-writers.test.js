import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateNewSessionThresholdDefaults } from '../migrate.js';

const rootDir = path.resolve(import.meta.dirname, '../../..');
let root;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-config-writers-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function cli(args, zylosDir = root) {
  return spawnSync(process.execPath, [path.join(rootDir, 'cli', 'zylos.js'), ...args], {
    env: { ...process.env, ZYLOS_DIR: zylosDir },
    encoding: 'utf8',
  });
}

describe('production config writers', () => {
  it('routes config CLI updates through the locked writer and reserves session_mode', () => {
    const saved = cli(['config', 'set', 'custom', 'value']);
    assert.equal(saved.status, 0, saved.stderr);
    const configFile = path.join(root, '.zylos', 'config.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { custom: 'value' });
    const lockInode = fs.statSync(`${configFile}.lock`).ino;

    const reserved = cli(['config', 'set', 'session_mode', 'single']);
    assert.notEqual(reserved.status, 0);
    assert.match(reserved.stderr, /session_mode is managed/);
    assert.equal(fs.statSync(`${configFile}.lock`).ino, lockInode);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), { custom: 'value' });
  });

  it('migrates only the explicitly supplied target and preserves falsey keys', () => {
    const other = path.join(root, 'other');
    const targetFile = path.join(root, '.zylos', 'config.json');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, JSON.stringify({ new_session_threshold: 0, unknown: false }));
    assert.equal(migrateNewSessionThresholdDefaults({ zylosDir: root }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(targetFile)), {
      new_session_threshold: 0,
      codex_new_session_threshold: 75,
      unknown: false,
    });
    assert.equal(fs.existsSync(path.join(other, '.zylos', 'config.json')), false);
  });

  it('refuses to overwrite malformed F1 during migration', () => {
    const configFile = path.join(root, '.zylos', 'config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, '{');
    assert.throws(() => migrateNewSessionThresholdDefaults({ zylosDir: root }), error => error.code === 'CONFIG_UNREADABLE');
    assert.equal(fs.readFileSync(configFile, 'utf8'), '{');
  });

  it('has no legacy writer references or standalone F1 overwrite implementation', () => {
    const production = [
      'cli/commands/runtime.js',
      'cli/commands/config.js',
      'cli/commands/init.js',
      'cli/lib/sync-settings-hooks.js',
      'cli/lib/migrate.js',
      'skills/http/scripts/setup-caddy.js',
    ];
    for (const relative of production) {
      const source = fs.readFileSync(path.join(rootDir, relative), 'utf8');
      assert.doesNotMatch(source, /\bupdateZylosConfig\b/, relative);
    }
    assert.doesNotMatch(fs.readFileSync(path.join(rootDir, 'cli/lib/migrate.js'), 'utf8'), /writeFileSync\(configPath/);
    assert.doesNotMatch(fs.readFileSync(path.join(rootDir, 'skills/http/scripts/setup-caddy.js'), 'utf8'), /writeFileSync\(CONFIG_FILE/);
  });
});
