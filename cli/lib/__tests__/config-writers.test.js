import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { migrateNewSessionThresholdDefaults } from '../migrate.js';

const rootDir = path.resolve(import.meta.dirname, '../../..');
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-config-writers-'));
});
function nativeModels() {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ model: 'opus[1m]' }));
  fs.writeFileSync(path.join(root, '.codex/config.toml'), 'model = "small"\n');
}
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

  it('refuses to overwrite malformed F1 during migration', async () => {
    const configFile = path.join(root, '.zylos', 'config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, '{');
    await assert.rejects(migrateNewSessionThresholdDefaults({ zylosDir: root }), error => error.code === 'CONFIG_UNREADABLE');
    assert.equal(fs.readFileSync(configFile, 'utf8'), '{');
  });

  it('keeps fresh-install and re-init defaults idempotent through real production writers', () => {
    nativeModels();
    const configUrl = pathToFileURL(path.join(rootDir, 'cli', 'lib', 'config.js')).href;
    const initUrl = pathToFileURL(path.join(rootDir, 'cli', 'commands', 'init.js')).href;
    const migrateUrl = pathToFileURL(path.join(rootDir, 'cli', 'lib', 'migrate.js')).href;
    const syncUrl = pathToFileURL(path.join(rootDir, 'cli', 'lib', 'runtime', 'claude', 'hooks.js')).href;
    const script = `
      const config = await import(${JSON.stringify(configUrl)});
      const init = await import(${JSON.stringify(initUrl)});
      const migrate = await import(${JSON.stringify(migrateUrl)});
      const sync = await import(${JSON.stringify(syncUrl)});
      config.updateZylosConfigLocked({ set: { runtime: 'claude', unknown: false } });
      await init.seedFreshInstallNewSessionThresholdDefault();
      config.updateZylosConfigLocked({ setIfAbsent: { session_mode: 'multi' } });
      await migrate.migrateNewSessionThresholdDefaults({ zylosDir: process.env.ZYLOS_DIR });
      await sync.syncModelCoupledNewSessionThreshold({ modelBackfilled: true, log: () => {} });
      config.updateZylosConfigLocked({ set: { runtime: 'codex' } });
      await migrate.migrateNewSessionThresholdDefaults({ zylosDir: process.env.ZYLOS_DIR });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ZYLOS_DIR: root },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.zylos', 'config.json'), 'utf8')), {
      runtime: 'codex',
      unknown: false,
      session_mode: 'multi',
    });
  });

});
