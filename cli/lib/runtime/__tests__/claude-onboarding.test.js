import { launchSession } from '../launch-flow.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
  const adapterOptions = { root, env,
    tmux: { binary: tmux.binary, socketPath: tmux.socketPath, configFile: '/dev/null' } };
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
    const result = await launchSession({ runtime: 'claude', sessionGroup: null, runId: 'onboarding-test', sessionMode: 'single', launchConfig: { runtime: 'claude', mode: 'default' } }, adapterOptions);
    assert.equal(result.tmuxName, 'zylos-group-origin');
    assert.equal(tmux.tmux('list-panes', '-t', '=zylos-group-origin', '-F', '#{pane_current_command}'), 'sleep');
  }
  return { home, root, config, settings, files, write, launch, options: adapterOptions };
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

// Both files can hold credentials (~/.claude.json approved key suffixes, settings env).
test('Claude launch creates missing confirmation files owner-only', async t => {
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));
  const f = fixture(t);
  await f.launch();
  for (const file of Object.values(f.files)) assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600', file);
});

test('Claude launch leaves true confirmations and user files byte-identical', async t => {
  const f = fixture(t);
  f.write();
  const projectSettings = path.join(f.root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(projectSettings));
  fs.writeFileSync(projectSettings, '{ "model": "sonnet", "effortLevel": "high" }\n\n');
  f.files.projectSettings = projectSettings;
  const before = Object.fromEntries(Object.entries(f.files).map(([name, file]) => [name, fs.readFileSync(file)]));
  await f.launch();
  for (const [name, file] of Object.entries(f.files)) assert.deepEqual(fs.readFileSync(file), before[name]);
  assert.deepEqual(fs.readdirSync(path.dirname(projectSettings)), ['settings.json']);
});

test('Claude launch pre-approves a .env API key on an already onboarded and trusted install', async t => {
  const f = fixture(t);
  f.config.customApiKeyResponses = { approved: ['older-approved-suffix'], rejected: [] };
  f.write();
  const key = 'sk-ant-api03-synthetic-onboarded-install-key';
  fs.writeFileSync(path.join(f.root, '.env'), `ANTHROPIC_API_KEY=${key}\n`);
  await f.launch();
  const saved = JSON.parse(fs.readFileSync(f.files.config, 'utf8'));
  assert.deepEqual(saved.customApiKeyResponses.approved, ['older-approved-suffix', key.slice(-20)]);
  assert.equal(saved.userConfigKey[0], 'keep');
  assert.equal(saved.projects[f.root].userProjectKey, 'keep');
});
