import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeAdapter } from '../claude.js';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';

function fixture(t) {
  const tmux = isolatedTmux(t, { prefix: 'p02-onboarding-' });
  const home = path.join(tmux.dir, 'home');
  const root = path.join(home, 'zylos');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(root);
  const executable = path.join(tmux.dir, 'claude');
  fs.writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.59 (Claude Code)"; exit 0; fi\nexec sleep 60\n', { mode: 0o700 });
  const env = { HOME: home, ZYLOS_DIR: root, PATH: process.env.PATH, CLAUDE_BIN: executable };
  const adapter = new ClaudeAdapter({ root, env,
    tmux: { binary: tmux.binary, socketPath: tmux.socketPath, configFile: '/dev/null' } });
  const files = { config: path.join(home, '.claude.json'), settings: path.join(home, '.claude', 'settings.json') };
  const config = {
    hasCompletedOnboarding: true, lastOnboardingVersion: 'existing-version', effortCalloutDismissed: true,
    projects: { [root]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, userProjectKey: 'keep' } },
    mcpServers: { personal: { command: 'user-command' } }, userConfigKey: ['keep'],
  };
  const settings = { skipDangerousModePermissionPrompt: true, mcpServers: { personal: { command: 'other-command' } }, userSettingsKey: 'keep' };
  const write = () => {
    fs.writeFileSync(files.config, JSON.stringify(config, null, 4) + '\n\n');
    fs.writeFileSync(files.settings, JSON.stringify(settings, null, 4) + '\n\n');
  };
  async function launch() {
    const result = await adapter.launch({ sessionGroup: null, runId: 'onboarding-test', sessionMode: 'single', launchConfig: { runtime: 'claude', mode: 'default' } });
    assert.equal(result.tmuxName, 'zylos-group-origin');
    assert.equal(tmux.tmux('list-panes', '-t', '=zylos-group-origin', '-F', '#{pane_current_command}'), 'sleep');
  }
  return { home, root, config, settings, files, write, launch, adapter };
}

for (const missing of ['onboarding', 'trust', 'project-onboarding', 'permission']) {
  test(`Claude launch repairs missing ${missing} during launch`, async t => {
    const f = fixture(t);
    if (missing === 'onboarding') { delete f.config.hasCompletedOnboarding; delete f.config.lastOnboardingVersion; delete f.config.effortCalloutDismissed; }
    if (missing === 'trust') delete f.config.projects[f.root].hasTrustDialogAccepted;
    if (missing === 'project-onboarding') delete f.config.projects[f.root].hasCompletedProjectOnboarding;
    if (missing === 'permission') delete f.settings.skipDangerousModePermissionPrompt;
    f.write();
    await f.launch();
    const config = JSON.parse(fs.readFileSync(f.files.config));
    const settings = JSON.parse(fs.readFileSync(f.files.settings));
    assert.equal(config.hasCompletedOnboarding, true);
    assert.equal(config.lastOnboardingVersion, missing === 'onboarding' ? '2.1.59 (Claude Code)' : 'existing-version');
    assert.equal(config.effortCalloutDismissed, true);
    assert.equal(config.projects[f.root].hasTrustDialogAccepted, true);
    assert.equal(config.projects[f.root].hasCompletedProjectOnboarding, true);
    assert.equal(settings.skipDangerousModePermissionPrompt, true);
    assert.deepEqual(config.mcpServers, f.config.mcpServers);
    assert.deepEqual(config.userConfigKey, f.config.userConfigKey);
    assert.equal(config.projects[f.root].userProjectKey, 'keep');
    assert.deepEqual(settings.mcpServers, f.settings.mcpServers);
    assert.equal(settings.userSettingsKey, 'keep');
  });
}

test('Claude launch creates missing confirmation files and project entry', async t => {
  const f = fixture(t);
  await f.launch();
  const config = JSON.parse(fs.readFileSync(f.files.config));
  const settings = JSON.parse(fs.readFileSync(f.files.settings));
  assert.equal(config.hasCompletedOnboarding, true);
  assert.equal(config.lastOnboardingVersion, '2.1.59 (Claude Code)');
  assert.equal(config.effortCalloutDismissed, true);
  assert.deepEqual(config.projects[f.root], { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true });
  assert.deepEqual(settings, { skipDangerousModePermissionPrompt: true });
});

for (const value of [true, false]) {
  test(`Claude launch leaves existing confirmation values (${value}) and user files byte-identical`, async t => {
    const f = fixture(t);
    f.config.hasCompletedOnboarding = value;
    f.config.effortCalloutDismissed = value;
    f.config.projects[f.root].hasTrustDialogAccepted = value;
    f.config.projects[f.root].hasCompletedProjectOnboarding = value;
    f.settings.skipDangerousModePermissionPrompt = value;
    f.write();
    const before = Object.fromEntries(Object.entries(f.files).map(([name, file]) => [name, fs.readFileSync(file)]));
    await f.launch();
    for (const [name, file] of Object.entries(f.files)) assert.deepEqual(fs.readFileSync(file), before[name]);
  });
}

for (const fileName of ['config', 'settings']) for (const failure of ['unreadable', 'unwritable', 'invalid-json']) {
  test(`Claude launch succeeds with ${failure} ${fileName} and preserves that file`, {
    skip: failure !== 'invalid-json' && process.getuid?.() === 0 ? 'Root bypasses POSIX file permission checks' : false,
  }, async t => {
    const f = fixture(t);
    delete f.config.hasCompletedOnboarding;
    delete f.settings.skipDangerousModePermissionPrompt;
    f.write();
    const file = f.files[fileName];
    if (failure === 'invalid-json') fs.writeFileSync(file, '{user data must not be replaced');
    const before = fs.readFileSync(file);
    const mode = failure === 'unreadable' ? 0o200 : failure === 'unwritable' ? 0o400 : 0o600;
    fs.chmodSync(file, mode);
    try {
      if (failure === 'unreadable') assert.throws(() => fs.readFileSync(file), { code: 'EACCES' });
      if (failure === 'unwritable') assert.throws(() => fs.accessSync(file, fs.constants.W_OK), { code: 'EACCES' });
      await f.launch();
    } finally { fs.chmodSync(file, 0o600); }
    assert.deepEqual(fs.readFileSync(file), before);
    const other = fileName === 'config' ? JSON.parse(fs.readFileSync(f.files.settings)) : JSON.parse(fs.readFileSync(f.files.config));
    assert.equal(fileName === 'config' ? other.skipDangerousModePermissionPrompt : other.hasCompletedOnboarding, true);
  });
}

for (const invalid of ['projects', 'project']) {
  test(`Claude launch preserves malformed ${invalid} and still repairs settings`, async t => {
    const f = fixture(t);
    if (invalid === 'projects') f.config.projects = null;
    else f.config.projects[f.root] = null;
    delete f.settings.skipDangerousModePermissionPrompt;
    f.write();
    const before = fs.readFileSync(f.files.config);
    await f.launch();
    assert.deepEqual(fs.readFileSync(f.files.config), before);
    assert.equal(JSON.parse(fs.readFileSync(f.files.settings)).skipDangerousModePermissionPrompt, true);
  });
}


test('Claude launch trusts the real startup directory when root is a symlink', async t => {
  const f = fixture(t);
  const linkedRoot = path.join(f.home, 'linked-zylos');
  fs.symlinkSync(f.root, linkedRoot, 'dir');
  f.adapter.options.root = linkedRoot;
  f.adapter.options.env.ZYLOS_DIR = linkedRoot;
  await f.launch();
  const config = JSON.parse(fs.readFileSync(f.files.config));
  const realRoot = fs.realpathSync(linkedRoot);
  assert.equal(config.projects[realRoot].hasTrustDialogAccepted, true);
  assert.equal(config.projects[realRoot].hasCompletedProjectOnboarding, true);
  assert.equal(Object.hasOwn(config.projects, linkedRoot), false);
});
