// covers: scripts/postinstall.js cli/commands/init.js
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
const INIT_NOTICE = 'This machine has already been initialized.';

const dirs = [];

function fixtureZylosDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-postinstall-local-'));
  dirs.push(home);
  const zylosDir = path.join(home, 'zylos');
  fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'), SETTINGS_BEFORE);
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude' }));
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'components.json'), '{}');
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
      // npm packages exclude development tests and dependencies are linked below.
      filter: (src) => !['node_modules', '__tests__', 'test'].includes(path.basename(src)),
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
  delete env.ZYLOS_SKIP_POSTINSTALL;
  const tmp = path.join(path.dirname(zylosDir), 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  return execFileSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    timeout: 30000,
    detached: true,
    stdio: 'pipe',
    env: {
      ...env,
      CI: '',
      HOME: path.dirname(zylosDir),
      ZYLOS_DIR: zylosDir,
      PM2_HOME: path.join(path.dirname(zylosDir), '.pm2'),
      TMPDIR: tmp,
      TMUX_TMPDIR: tmp,
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
  // Integration: real npm postinstall publication across two private package
  // locations. Run for installation-record writers; skip unrelated hooks. Owned
  // temporary HOME/ZYLOS_DIR and package copies; no installer or service start.
  it('publishes and refreshes the Core location while protected installs leave it unchanged', () => {
    const zylosDir = fixtureZylosDir(), first = installedPostinstallPath(), second = installedPostinstallPath();
    const record = path.join(zylosDir, '.claude/skills/comm-bridge/.zylos/core-package.json');
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, first);
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')),
      { v: 1, packageRoot: fs.realpathSync(path.dirname(path.dirname(first))) });
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, second);
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')),
      { v: 1, packageRoot: fs.realpathSync(path.dirname(path.dirname(second))) });
    const before = fs.readFileSync(record);
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, { ZYLOS_PROTECTED_INSTALL: '1' }, first);
    assert.equal(fs.readFileSync(record).equals(before), true);
  });

  // Integration: real smartSync gets an OS file/directory collision while another
  // document updates. Run for merge-error publication guards; skip other hooks.
  // Two owned package copies and one private deployment; no services/installers.
  it('does not advance the location record when skill merging reports an error', () => {
    const zylosDir = fixtureZylosDir(), first = installedPostinstallPath(), second = installedPostinstallPath();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, first);
    const skill = path.join(zylosDir, '.claude/skills/comm-bridge');
    const record = path.join(skill, '.zylos/core-package.json');
    const before = fs.readFileSync(record);
    const source = path.join(path.dirname(path.dirname(second)), 'skills/comm-bridge');
    fs.appendFileSync(path.join(source, 'SKILL.md'), '\nAdditional package documentation.\n');
    fs.writeFileSync(path.join(source, 'publication-check.txt'), 'new package document\n');
    fs.mkdirSync(path.join(skill, 'publication-check.txt'));
    const output = runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, second);
    assert.match(output, /~ comm-bridge \([^\n]*1 errors\)/);
    assert.equal(fs.readFileSync(record).equals(before), true);
    assert.notEqual(JSON.parse(before).packageRoot, fs.realpathSync(path.dirname(path.dirname(second))));
    assert.equal(fs.statSync(path.join(skill, 'publication-check.txt')).isDirectory(), true);
  });

  it('writes nothing for npm install / npm ci inside a source checkout', () => {
    const zylosDir = fixtureZylosDir();
    const output = runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'ci' });
    assert.equal(output.includes(INIT_NOTICE), false);
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

});
