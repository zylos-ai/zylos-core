import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const POSTINSTALL_PATH = path.join(REPO_ROOT, 'scripts', 'postinstall.js');
const PACKAGE_ENTRIES = ['package.json', 'scripts', 'cli', 'skills', 'templates'];
const SETTINGS_BEFORE = JSON.stringify({ hooks: {} });

const dirs = [];

function fixtureZylosDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-postinstall-local-'));
  dirs.push(home);
  const zylosDir = path.join(home, 'zylos');
  fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'), SETTINGS_BEFORE);
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  return zylosDir;
}

// Copy of the package as npm installs it: <prefix>/lib/node_modules/zylos
function installedPostinstallPath() {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-postinstall-prefix-'));
  dirs.push(prefix);
  const packageRoot = path.join(prefix, 'lib', 'node_modules', 'zylos');
  for (const entry of PACKAGE_ENTRIES) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(packageRoot, entry), {
      recursive: true,
      filter: (src) => path.basename(src) !== 'node_modules',
    });
  }
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(packageRoot, 'node_modules'), 'dir');
  return path.join(packageRoot, 'scripts', 'postinstall.js');
}

// Run postinstall the way npm would, with only the npm config variables given here
function runPostinstall(zylosDir, npmEnv = {}, extraEnv = {}, scriptPath = POSTINSTALL_PATH) {
  assert.notEqual(path.dirname(zylosDir), os.tmpdir(), 'Postinstall HOME must not be the shared temporary directory');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_')));
  delete env.ZYLOS_PROTECTED_INSTALL;
  execFileSync(process.execPath, [scriptPath], {
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

  it('syncs for uppercase and mixed-case NPM_CONFIG_GLOBAL / NPM_CONFIG_LOCATION forms', () => {
    for (const npmEnv of [
      { NPM_CONFIG_GLOBAL: 'true' },
      { NPM_CONFIG_LOCATION: 'global' },
      { Npm_config_Global: 'true' },
      { Npm_config_Location: 'global' },
    ]) {
      const zylosDir = fixtureZylosDir();
      runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'install', ...npmEnv });
      assert.equal(skillsSynced(zylosDir), true);
      assert.equal(settingsSynced(zylosDir), true);
    }
  });

  it('lets an explicit lowercase local override win over uppercase or mixed-case global', () => {
    for (const global of [{ NPM_CONFIG_GLOBAL: 'true' }, { Npm_config_Global: 'true' }]) {
      const zylosDir = fixtureZylosDir();
      runPostinstall(zylosDir, {
        npm_lifecycle_event: 'postinstall',
        npm_command: 'install',
        ...global,
        npm_config_global: '',
      });
      assert.equal(skillsSynced(zylosDir), false);
      assert.equal(settingsSynced(zylosDir), false);
    }
  });

  it('syncs when the package is installed inside node_modules, whatever npm config says', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'install' }, {}, installedPostinstallPath());
    assert.equal(skillsSynced(zylosDir), true);
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade')), true);
    assert.equal(settingsSynced(zylosDir), true);
  });

  it('preserves shared files during protected installation (npm install -g <tgz>)', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(
      zylosDir,
      { npm_lifecycle_event: 'postinstall', npm_command: 'install' },
      { ZYLOS_SKIP_POSTINSTALL: '1', ZYLOS_PROTECTED_INSTALL: '1' },
      installedPostinstallPath(),
    );
    assert.equal(skillsSynced(zylosDir), false);
    assert.equal(settingsSynced(zylosDir), false);
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade')), false);
    assert.equal(fs.existsSync(path.join(zylosDir, '.codex')), false);
  });

  it('retains settings synchronization for the legacy skip-skills flag', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'install' },
      { ZYLOS_SKIP_POSTINSTALL: '1', ZYLOS_PROTECTED_INSTALL: '' }, installedPostinstallPath());
    assert.equal(skillsSynced(zylosDir), false);
    assert.equal(settingsSynced(zylosDir), true);
  });

  for (const value of [undefined, '', '0', 'false', 'true', '01', ' 1']) it(`does not suppress shared writes for protected flag ${JSON.stringify(value)}`, () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_config_global: 'true' },
      { ZYLOS_SKIP_POSTINSTALL: '', ...(value === undefined ? {} : { ZYLOS_PROTECTED_INSTALL: value }) });
    assert.equal(skillsSynced(zylosDir), true);
    assert.equal(settingsSynced(zylosDir), true);
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade')), true);
  });

  for (const value of ['', '0', 'false', 'true']) it(`does not suppress skill synchronization for legacy flag ${JSON.stringify(value)}`, () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_config_global: 'true' },
      { ZYLOS_SKIP_POSTINSTALL: value, ZYLOS_PROTECTED_INSTALL: '' });
    assert.equal(skillsSynced(zylosDir), true);
    assert.equal(settingsSynced(zylosDir), true);
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade')), true);
  });

  it('preserves shared files when the installer supplies the legacy CI suppression', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_config_global: 'true' }, { CI: '1' });
    assert.equal(skillsSynced(zylosDir), false);
    assert.equal(settingsSynced(zylosDir), false);
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade')), false);
  });

  for (const value of ['0', 'false']) it(`preserves legacy truthy CI suppression for ${JSON.stringify(value)}`, () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_config_global: 'true' }, { CI: value });
    assert.equal(skillsSynced(zylosDir), false);
    assert.equal(settingsSynced(zylosDir), false);
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade')), false);
  });

  it('negative control: removing suppression violates the pre-cutoff settings invariant', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'install' },
      { CI: '', ZYLOS_SKIP_POSTINSTALL: '1', ZYLOS_PROTECTED_INSTALL: '' }, installedPostinstallPath());
    const settings = fs.readFileSync(path.join(zylosDir, '.claude', 'settings.json'), 'utf8');
    assert.notEqual(settings, SETTINGS_BEFORE);
    assert.throws(() => assert.equal(settings, SETTINGS_BEFORE), { code: 'ERR_ASSERTION' });
  });

  it('keeps syncing when run directly outside npm', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir);
    assert.equal(skillsSynced(zylosDir), true);
    assert.equal(settingsSynced(zylosDir), true);
  });
});
