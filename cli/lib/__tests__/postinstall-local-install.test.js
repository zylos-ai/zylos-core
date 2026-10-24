import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTINSTALL_PATH = path.join(__dirname, '..', '..', '..', 'scripts', 'postinstall.js');
const SETTINGS_BEFORE = JSON.stringify({ hooks: {} });

const dirs = [];

function fixtureZylosDir() {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-postinstall-local-'));
  dirs.push(zylosDir);
  fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'), SETTINGS_BEFORE);
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  return zylosDir;
}

// Run postinstall the way npm would, with only the npm_* variables given here
function runPostinstall(zylosDir, npmEnv = {}, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('npm_')));
  execFileSync(process.execPath, [POSTINSTALL_PATH], {
    stdio: 'pipe',
    env: {
      ...env,
      CI: '',
      HOME: path.dirname(zylosDir),
      ZYLOS_DIR: zylosDir,
      ...npmEnv,
      ...extraEnv,
    },
  });
}

function skillsSynced(zylosDir) {
  const skillsDir = path.join(zylosDir, '.claude', 'skills');
  return fs.existsSync(skillsDir) && fs.readdirSync(skillsDir).length > 0;
}

function settingsSynced(zylosDir) {
  return fs.readFileSync(path.join(zylosDir, '.claude', 'settings.json'), 'utf8') !== SETTINGS_BEFORE;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('postinstall local install guard', () => {
  it('writes nothing for npm install / npm ci inside a source checkout', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'ci' });
    assert.equal(skillsSynced(zylosDir), false);
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade')), false);
    assert.equal(settingsSynced(zylosDir), false);
  });

  it('syncs skills and settings for npm install -g (install.sh, Docker)', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'install', npm_config_global: 'true' });
    assert.equal(skillsSynced(zylosDir), true);
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade')), true);
    assert.equal(settingsSynced(zylosDir), true);
  });

  it('syncs for npm install --location=global', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'install', npm_config_location: 'global' });
    assert.equal(skillsSynced(zylosDir), true);
    assert.equal(settingsSynced(zylosDir), true);
  });

  it('still syncs settings only during self-upgrade (npm install -g <tgz>)', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(
      zylosDir,
      { npm_lifecycle_event: 'postinstall', npm_command: 'install', npm_config_global: 'true' },
      { ZYLOS_SKIP_POSTINSTALL: '1' },
    );
    assert.equal(skillsSynced(zylosDir), false);
    assert.equal(settingsSynced(zylosDir), true);
  });

  it('keeps syncing when run directly outside npm', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir);
    assert.equal(skillsSynced(zylosDir), true);
    assert.equal(settingsSynced(zylosDir), true);
  });
});
