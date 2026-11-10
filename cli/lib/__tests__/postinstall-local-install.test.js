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

  // Integration: real postinstall reports failed optional record publication.
  // Run for warning/record failure changes; skip unrelated services. The existing
  // fixture owns all files and child execution is synchronous and time-bounded.
  it('warns when the Core location cannot be published without replacing the blocked record', () => {
    const zylosDir = fixtureZylosDir(), script = installedPostinstallPath();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, script);
    const record = path.join(zylosDir, '.claude/skills/comm-bridge/.zylos/core-package.json');
    fs.unlinkSync(record); fs.mkdirSync(record);
    const output = runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, script);
    assert.match(output, /Warning: Core package location record was not updated: Unsafe Core package location record/);
    assert.match(output, /Set ZYLOS_PACKAGE_ROOT.*rerun zylos init/);
    assert.doesNotMatch(output, /Failed to update comm-bridge/);
    assert.equal(fs.statSync(record).isDirectory(), true);
  });

  // Integration: real three-way documentation conflict and failed record write.
  // Run for postinstall result/publication ordering; skip unrelated services.
  // Package copies, deployment, backup and blocked record are fixture-owned;
  // the bounded absolute-Node child never installs packages or starts services.
  it('reports the successful merge and conflict backup before a location publication warning', () => {
    const zylosDir = fixtureZylosDir(), script = installedPostinstallPath();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, script);
    const skill = path.join(zylosDir, '.claude/skills/comm-bridge');
    const deployed = path.join(skill, 'SKILL.md');
    const source = path.join(path.dirname(path.dirname(script)), 'skills/comm-bridge/SKILL.md');
    const alterLine = (text, value) => { const lines = text.split('\n'); lines[2] = value; return lines.join('\n'); };
    const local = alterLine(fs.readFileSync(deployed, 'utf8'), 'description: local documentation change');
    fs.writeFileSync(deployed, local);
    fs.writeFileSync(source, alterLine(fs.readFileSync(source, 'utf8'), 'description: upstream documentation change'));
    const record = path.join(skill, '.zylos/core-package.json');
    fs.unlinkSync(record); fs.mkdirSync(record);
    const output = runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, script);
    assert.match(output, /~ comm-bridge \(1 conflicts\)/);
    const backup = /Conflict backup: (.+\/comm-bridge\/SKILL\.md)/.exec(output)?.[1];
    assert.ok(backup, 'the overwritten local document must have a visible backup path');
    assert.ok(backup.startsWith(path.join(path.dirname(zylosDir), 'tmp') + path.sep));
    assert.equal(fs.readFileSync(backup, 'utf8'), local);
    assert.match(fs.readFileSync(deployed, 'utf8'), /upstream documentation change/);
    const warning = output.indexOf('Warning: Core package location record was not updated:');
    assert.ok(warning > output.indexOf('Conflict backup:'));
    assert.match(output, /Core Skills: 0 added, 1 updated,/);
    assert.doesNotMatch(output, /Failed to update comm-bridge/);
    assert.equal(fs.statSync(record).isDirectory(), true);
  });

  // Integration: a fresh skill copies successfully but brings a blocked metadata
  // target from a private package fixture. Run for first-sync warning/counting;
  // skip unrelated hooks. All files and child resources stay under private roots.
  it('counts a freshly copied skill even when its location record cannot be published', () => {
    const zylosDir = fixtureZylosDir(), script = installedPostinstallPath();
    const packageRoot = path.dirname(path.dirname(script));
    fs.mkdirSync(path.join(packageRoot, 'skills/comm-bridge/.zylos/core-package.json'), { recursive: true });
    const output = runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, script);
    assert.match(output, /\+ comm-bridge/);
    assert.match(output, /Warning: Core package location record was not updated:/);
    assert.ok(output.indexOf('+ comm-bridge') < output.indexOf('Warning: Core package location record was not updated:'));
    assert.doesNotMatch(output, /Failed to sync comm-bridge/);
    const totalSkills = fs.readdirSync(path.join(packageRoot, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
    assert.ok(output.includes(`Core Skills: ${totalSkills} added, 0 updated, 0 unchanged.`));
    assert.equal(fs.existsSync(path.join(zylosDir, '.claude/skills/comm-bridge/SKILL.md')), true);
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

  it('prints recovery and normal upgrade commands after direct npm installation on an initialized machine', () => {
    const zylosDir = fixtureZylosDir();
    const output = runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, installedPostinstallPath());
    assert.equal(output.split(INIT_NOTICE).length - 1, 1);
    assert.match(output, /Run "zylos init" to finish service, dependency and data initialization/);
    assert.match(output, /For normal upgrades, use "zylos upgrade --self"/);
    assert.equal(fs.readFileSync(path.join(zylosDir, '.zylos', 'components.json'), 'utf8'), '{}');
    assert.equal(fs.existsSync(path.join(zylosDir, 'pm2')), false);
    assert.equal(fs.existsSync(path.join(zylosDir, 'scheduler')), false);
  });

  it('omits the initialized-machine notice on a fresh machine', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-postinstall-fresh-'));
    dirs.push(home);
    const zylosDir = path.join(home, 'zylos');
    const output = runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, installedPostinstallPath());
    assert.equal(output.includes(INIT_NOTICE), false);
    assert.match(output, /Zylos not initialized/);
    assert.equal(fs.existsSync(zylosDir), false);
  });

  it('omits the initialized-machine notice when only the Claude directory exists', () => {
    const zylosDir = fixtureZylosDir();
    fs.unlinkSync(path.join(zylosDir, '.zylos', 'components.json'));
    const output = runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, {}, installedPostinstallPath());
    assert.equal(output.includes(INIT_NOTICE), false);
  });

  for (const extraEnv of [{ ZYLOS_PROTECTED_INSTALL: '1' }, { ZYLOS_SKIP_POSTINSTALL: '1' }, { CI: '1' }]) {
    it(`omits the initialized-machine notice during upgrade installation with ${Object.keys(extraEnv)[0]}`, () => {
      const zylosDir = fixtureZylosDir();
      const output = runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall' }, extraEnv, installedPostinstallPath());
      assert.equal(output.includes(INIT_NOTICE), false);
    });
  }

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

  it('syncs for npm install --location=global', () => {
    const zylosDir = fixtureZylosDir();
    runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'install', npm_config_location: 'global' });
    assert.equal(skillsSynced(zylosDir), true);
    assert.equal(settingsSynced(zylosDir), true);
  });

  for (const npmEnv of [
    { NPM_CONFIG_GLOBAL: 'true' },
    { NPM_CONFIG_LOCATION: 'global' },
    { Npm_config_Global: 'true' },
    { Npm_config_Location: 'global' },
  ]) {
    it(`syncs for npm global config ${Object.keys(npmEnv)[0]}`, () => {
      const zylosDir = fixtureZylosDir();
      runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'install', ...npmEnv });
      assert.equal(skillsSynced(zylosDir), true);
      assert.equal(settingsSynced(zylosDir), true);
    });
  }

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
    const output = runPostinstall(zylosDir, { npm_lifecycle_event: 'postinstall', npm_command: 'install' }, {}, installedPostinstallPath());
    assert.equal(skillsSynced(zylosDir), true);
    assert.equal(fs.existsSync(path.join(zylosDir, '.zylos', 'upgrade')), true);
    assert.equal(settingsSynced(zylosDir), true, output);
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

  it('keeps syncing when run directly outside npm', () => {
    const zylosDir = fixtureZylosDir();
    const output = runPostinstall(zylosDir);
    assert.equal(output.includes(INIT_NOTICE), false);
    assert.equal(skillsSynced(zylosDir), true);
    assert.equal(settingsSynced(zylosDir), true);
  });
});
