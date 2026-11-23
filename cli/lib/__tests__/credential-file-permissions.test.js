import test, { after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Credential and settings files must stay owner-only: a new file is created
// 0600, a rewrite tightens an existing 0644 file, and backups/restores are 0600.
// Runs under a fresh HOME and ZYLOS_DIR with umask 022; no runtime, network,
// PM2, tmux or database is started. Run when a credential or settings writer,
// or the owner-only file helpers, change.
const posix = process.platform !== 'win32';
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'credential-file-mode-')));
const home = path.join(root, 'home'), zylos = path.join(root, 'zylos'), bin = path.join(root, 'bin');
const credentialKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY'];
const preserved = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PATH', ...credentialKeys].map(key => [key, process.env[key]]));
const originalUmask = process.umask(0o022);
for (const dir of [home, zylos, bin]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "fixture-version\\n"\n', { mode: 0o755 });
process.env.HOME = home;
process.env.ZYLOS_DIR = zylos;
process.env.PATH = bin;
for (const key of credentialKeys) delete process.env[key];
assert.equal(os.homedir(), home, 'HOME is isolated before any writer runs');
console.log('Credential file isolation: ' + JSON.stringify({ HOME: os.homedir(), ZYLOS_DIR: process.env.ZYLOS_DIR, PATH: process.env.PATH, umask: '022' }));

const claude = await import('../runtime/claude/auth.js');
const codex = await import('../runtime/codex/auth.js');
const { persistInstalledSettingsAndSyncCoupledThreshold } = await import('../runtime/claude/hooks.js');
const { copyPrivateFile, writePrivateFile } = await import('../private-file.js');

after(() => {
  process.umask(originalUmask);
  for (const [key, value] of Object.entries(preserved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const userSettings = path.join(home, '.claude', 'settings.json');
const claudeJson = path.join(home, '.claude.json');
const codexAuth = path.join(home, '.codex', 'auth.json');
const projectSettings = path.join(zylos, '.claude', 'settings.json');
const mode = file => (fs.statSync(file).mode & 0o777).toString(8);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const remove = (...files) => { for (const file of files) fs.rmSync(file, { force: true }); };
function worldReadable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  fs.chmodSync(file, 0o644);
  assert.equal(mode(file), '644');
}
const backups = dir => fs.readdirSync(dir).filter(name => /^settings\.json\.bak\.\d+$/.test(name)).map(name => path.join(dir, name));

beforeEach(() => {
  for (const key of credentialKeys) delete process.env[key];
  remove(userSettings, claudeJson, codexAuth, projectSettings);
  for (const file of fs.existsSync(path.dirname(projectSettings)) ? backups(path.dirname(projectSettings)) : []) remove(file);
});

describe('owner-only credential files', { skip: !posix && 'POSIX permission bits only' }, () => {
  describe('Claude credential writers (~/.claude.json; ~/.claude/settings.json is not written)', () => {
    for (const [label, save, key] of [
      ['saveApiKey', claude.saveApiKey, 'ANTHROPIC_API_KEY'],
      ['saveAuthToken', claude.saveAuthToken, 'ANTHROPIC_AUTH_TOKEN'],
      ['saveSetupToken', claude.saveSetupToken, 'CLAUDE_CODE_OAUTH_TOKEN'],
    ]) {
      test(`${label} creates ~/.claude.json owner-only and does not create settings.json`, () => {
        assert.equal(save('credential-value-new-file-0001'), true);
        assert.equal(mode(claudeJson), '600');
        assert.equal(fs.existsSync(userSettings), false);
        assert.equal(process.env[key], 'credential-value-new-file-0001');
      });

    }

  });

  describe('Codex credential writer (~/.codex/auth.json)', () => {
    test('saveCodexApiKey creates auth.json owner-only', () => {
      assert.equal(codex.saveCodexApiKey('credential-value-0009'), true);
      assert.equal(mode(codexAuth), '600');
    });

  });

  describe('project settings ($ZYLOS_DIR/.claude/settings.json)', () => {
    const persist = (options = {}) => persistInstalledSettingsAndSyncCoupledThreshold({
      installedSettings: { hooks: {}, env: { ANTHROPIC_API_KEY: 'credential-value-0011' } },
      settingsPath: projectSettings, syncThreshold: () => ({ changed: false }), ...options,
    });

    test('hook sync tightens existing settings and writes an owner-only backup', () => {
      worldReadable(projectSettings, { hooks: {}, before: true });
      persist();
      assert.equal(mode(projectSettings), '600');
      const [backup, ...extra] = backups(path.dirname(projectSettings));
      assert.equal(extra.length, 0);
      assert.equal(mode(backup), '600');
      assert.equal(readJson(backup).before, true);
    });

  });

  describe('owner-only file helpers', () => {
    test('a copy is owner-only whether the target is new or world-readable', () => {
      const source = path.join(root, 'copy-source.json'), target = path.join(root, 'copy-target.json');
      worldReadable(source, { secret: 'credential-value-0012' });
      copyPrivateFile(source, target);
      assert.equal(mode(target), '600');
      fs.chmodSync(target, 0o644);
      copyPrivateFile(source, target);
      assert.equal(mode(target), '600');
      assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source));
    });

    // Records the mode of the destination at the moment each write call runs.
    function modesSeenByWrites(t, action) {
      const realWrite = fs.writeFileSync, seen = [];
      t.after(() => { fs.writeFileSync = realWrite; });
      fs.writeFileSync = function (target, ...rest) {
        const stat = typeof target === 'number' ? fs.fstatSync(target) : fs.existsSync(target) ? fs.statSync(target) : null;
        seen.push(stat ? (stat.mode & 0o777).toString(8) : 'new');
        return realWrite.call(this, target, ...rest);
      };
      try { action(); } finally { fs.writeFileSync = realWrite; }
      return seen;
    }

    test('an existing world-readable file is restricted before new content is written', t => {
      worldReadable(userSettings, { env: {} });
      assert.deepEqual(modesSeenByWrites(t, () => writePrivateFile(userSettings, '{"env":{"ANTHROPIC_API_KEY":"credential-value-0013"}}\n')), ['600']);
      assert.equal(readJson(userSettings).env.ANTHROPIC_API_KEY, 'credential-value-0013');
    });


  });
});
