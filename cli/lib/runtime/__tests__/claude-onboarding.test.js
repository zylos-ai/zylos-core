import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeAdapter } from '../claude.js';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';

function fixture(t) {
  const tmux = isolatedTmux(t, { prefix: 'session-runtime-onboarding-' });
  const home = path.join(fs.realpathSync(tmux.dir), 'home');
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

for (const state of ['missing', 'false']) for (const missing of ['onboarding', 'trust', 'permission']) {
  test(`Claude launch repairs ${state} ${missing} during launch`, async t => {
    const f = fixture(t);
    const unset = (object, key) => { if (state === 'missing') delete object[key]; else object[key] = false; };
    if (missing === 'onboarding') {
      unset(f.config, 'hasCompletedOnboarding');
      unset(f.config, 'effortCalloutDismissed');
      if (state === 'missing') delete f.config.lastOnboardingVersion;
    }
    if (missing === 'trust') {
      unset(f.config.projects[f.root], 'hasTrustDialogAccepted');
      unset(f.config.projects[f.root], 'hasCompletedProjectOnboarding');
    }
    if (missing === 'permission') unset(f.settings, 'skipDangerousModePermissionPrompt');
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

for (const state of ['missing', 'false']) {
  test(`Claude launch leaves all true confirmations byte-identical with ${state} project-onboarding`, async t => {
    const f = fixture(t);
    if (state === 'missing') delete f.config.projects[f.root].hasCompletedProjectOnboarding;
    else f.config.projects[f.root].hasCompletedProjectOnboarding = false;
    f.write();
    const before = Object.fromEntries(Object.entries(f.files).map(([name, file]) => [name, fs.readFileSync(file)]));
    await f.launch();
    for (const [name, file] of Object.entries(f.files)) assert.deepEqual(fs.readFileSync(file), before[name]);
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

test('Claude launch leaves true confirmations and user files byte-identical', async t => {
  const f = fixture(t);
  f.write();
  const before = Object.fromEntries(Object.entries(f.files).map(([name, file]) => [name, fs.readFileSync(file)]));
  await f.launch();
  for (const [name, file] of Object.entries(f.files)) assert.deepEqual(fs.readFileSync(file), before[name]);
});

for (const content of ['{invalid JSON', 'null', '[]', '42', '"text"']) {
  test(`Claude launch repairs non-object confirmation files (${content})`, async t => {
    const f = fixture(t);
    for (const file of Object.values(f.files)) fs.writeFileSync(file, content);
    await f.launch();
    const config = JSON.parse(fs.readFileSync(f.files.config));
    const settings = JSON.parse(fs.readFileSync(f.files.settings));
    assert.equal(config.hasCompletedOnboarding, true);
    assert.equal(config.lastOnboardingVersion, '2.1.59 (Claude Code)');
    assert.equal(config.effortCalloutDismissed, true);
    assert.deepEqual(config.projects[f.root], { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true });
    assert.deepEqual(settings, { skipDangerousModePermissionPrompt: true });
  });
}

for (const fileName of ['config', 'settings']) for (const failure of ['unreadable', 'unwritable']) {
  test(`Claude launch succeeds with ${failure} ${fileName} and preserves that file`, {
    skip: process.getuid?.() === 0 ? 'Root bypasses POSIX file permission checks' : false,
  }, async t => {
    const f = fixture(t);
    delete f.config.hasCompletedOnboarding;
    delete f.settings.skipDangerousModePermissionPrompt;
    f.write();
    const file = f.files[fileName];
    const before = fs.readFileSync(file);
    const mode = failure === 'unreadable' ? 0o200 : 0o400;
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

for (const invalid of ['projects', 'project']) for (const value of [null, [], false]) {
  test(`Claude launch repairs malformed ${invalid} (${JSON.stringify(value)})`, async t => {
    const f = fixture(t);
    if (invalid === 'projects') f.config.projects = value;
    else f.config.projects[f.root] = value;
    delete f.settings.skipDangerousModePermissionPrompt;
    f.write();
    await f.launch();
    const config = JSON.parse(fs.readFileSync(f.files.config));
    assert.deepEqual(config.projects[f.root], { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true });
    assert.deepEqual(config.mcpServers, f.config.mcpServers);
    assert.deepEqual(config.userConfigKey, f.config.userConfigKey);
    assert.equal(config.lastOnboardingVersion, 'existing-version');
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
