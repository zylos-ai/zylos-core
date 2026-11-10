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

const setup = await import('../runtime-setup.js');
const { preAcceptClaudeTerms, runInitAuthentication } = await import('../../commands/init.js');
const { applyBaseUrl } = await import('../../commands/runtime.js');
const { persistInstalledSettingsAndSyncCoupledThreshold } = await import('../sync-runtime-hooks.js');
const { reconcileAssemblerSettingsFile, updateFailureReport } = await import('../instruction-migration.js');
const { checkPrivateFile, copyPrivateFile, writePrivateFile } = await import('../private-file.js');
const { writeEnvEntries } = await import('../env.js');

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
      ['saveApiKey', setup.saveApiKey, 'ANTHROPIC_API_KEY'],
      ['saveAuthToken', setup.saveAuthToken, 'ANTHROPIC_AUTH_TOKEN'],
      ['saveSetupToken', setup.saveSetupToken, 'CLAUDE_CODE_OAUTH_TOKEN'],
    ]) {
      test(`${label} creates ~/.claude.json owner-only and does not create settings.json`, () => {
        assert.equal(save('credential-value-new-file-0001'), true);
        assert.equal(mode(claudeJson), '600');
        assert.equal(fs.existsSync(userSettings), false);
        assert.equal(process.env[key], 'credential-value-new-file-0001');
      });

      test(`${label} tightens an existing world-readable ~/.claude.json and leaves settings.json unchanged`, () => {
        worldReadable(userSettings, { theme: 'dark', env: { [key]: 'hand-configured' } });
        worldReadable(claudeJson, { keep: true });
        const settingsBefore = fs.readFileSync(userSettings, 'utf8');
        assert.equal(save('credential-value-existing-0002'), true);
        assert.equal(mode(claudeJson), '600');
        assert.equal(readJson(claudeJson).keep, true);
        assert.equal(fs.readFileSync(userSettings, 'utf8'), settingsBefore);
      });
    }

    test('approveApiKey creates ~/.claude.json owner-only and tightens an existing one', () => {
      setup.approveApiKey('credential-value-approve-0003');
      assert.equal(mode(claudeJson), '600');
      worldReadable(claudeJson, { keep: true });
      setup.approveApiKey('credential-value-approve-0004');
      assert.equal(mode(claudeJson), '600');
      assert.equal(readJson(claudeJson).keep, true);
    });

    test('saveClaudeBaseUrlToEnv neither creates nor rewrites settings.json', () => {
      assert.equal(setup.saveClaudeBaseUrlToEnv('https://relay.example.test'), true);
      assert.equal(fs.existsSync(userSettings), false);
      worldReadable(userSettings, { env: { ANTHROPIC_API_KEY: 'credential-value-0005', ANTHROPIC_BASE_URL: 'https://hand.example.test' } });
      const before = fs.readFileSync(userSettings, 'utf8');
      assert.equal(setup.saveClaudeBaseUrlToEnv('https://relay2.example.test'), true);
      assert.equal(fs.readFileSync(userSettings, 'utf8'), before);
    });

    test('init terms pre-acceptance creates both files owner-only', () => {
      assert.equal(preAcceptClaudeTerms(), true);
      assert.equal(mode(userSettings), '600');
      assert.equal(mode(claudeJson), '600');
    });

    test('init terms pre-acceptance tightens existing world-readable files it rewrites', () => {
      worldReadable(userSettings, { env: { ANTHROPIC_API_KEY: 'credential-value-0006' } });
      worldReadable(claudeJson, { keep: true });
      assert.equal(preAcceptClaudeTerms(), true);
      assert.equal(mode(userSettings), '600');
      assert.equal(mode(claudeJson), '600');
    });

    test('init setup-token rollback clears the process token and leaves settings.json unchanged', async () => {
      // A hand-configured, world-readable settings.json holding a token must not be rewritten.
      worldReadable(userSettings, { env: { CLAUDE_CODE_OAUTH_TOKEN: 'hand-configured-token' } });
      const before = fs.readFileSync(userSettings, 'utf8');
      const result = await runInitAuthentication({ setupToken: 'credential-value-0007' }, {
        runtime: 'claude', quiet: true, skipConfirm: true, exists: () => true, claudeStatus: () => false,
        setupSave: () => { process.env.CLAUDE_CODE_OAUTH_TOKEN = 'credential-value-0007'; return true; },
        setupVerify: () => ({ valid: false, authError: true }), log: () => {}, reportError: () => {},
      });
      assert.equal(result.claudeAuthenticated, false);
      assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(fs.readFileSync(userSettings, 'utf8'), before);
      assert.equal(mode(userSettings), '644');
    });

    test('runtime base URL save leaves settings owner-only without warnings', () => {
      worldReadable(userSettings, { env: { ANTHROPIC_API_KEY: 'credential-value-0008' } });
      const warnings = [];
      assert.equal(applyBaseUrl('claude', 'https://relay.example.test', warnings), true);
      assert.equal(mode(userSettings), '600');
      assert.deepEqual(warnings, []);
    });
  });

  describe('Codex credential writer (~/.codex/auth.json)', () => {
    test('saveCodexApiKey creates auth.json owner-only', () => {
      assert.equal(setup.saveCodexApiKey('credential-value-0009'), true);
      assert.equal(mode(codexAuth), '600');
    });

    test('saveCodexApiKey tightens an existing world-readable auth.json', () => {
      worldReadable(codexAuth, { tokens: { keep: true } });
      assert.equal(setup.saveCodexApiKey('credential-value-0010'), true);
      assert.equal(mode(codexAuth), '600');
      assert.deepEqual(readJson(codexAuth).tokens, { keep: true });
    });
  });

  describe('project settings ($ZYLOS_DIR/.claude/settings.json)', () => {
    const persist = (options = {}) => persistInstalledSettingsAndSyncCoupledThreshold({
      installedSettings: { hooks: {}, env: { ANTHROPIC_API_KEY: 'credential-value-0011' } },
      settingsPath: projectSettings, syncThreshold: () => ({ changed: false }), ...options,
    });

    test('hook sync creates settings owner-only without a backup', () => {
      persist();
      assert.equal(mode(projectSettings), '600');
      assert.equal(backups(path.dirname(projectSettings)).length, 0);
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

    test('hook sync restores the backup owner-only when the write fails', () => {
      worldReadable(projectSettings, { hooks: {}, before: true });
      const original = fs.readFileSync(projectSettings);
      assert.throws(() => persist({ writeFileSync: () => { throw new Error('disk full'); } }), /disk full/);
      assert.deepEqual(fs.readFileSync(projectSettings), original);
      assert.equal(mode(projectSettings), '600');
      const [backup] = backups(path.dirname(projectSettings));
      assert.equal(mode(backup), '600');
    });

    test('instruction migration writes settings owner-only, new or existing', () => {
      let result = reconcileAssemblerSettingsFile({ zylosDir: zylos, apply: true });
      assert.equal(result.changed, true);
      assert.equal(mode(projectSettings), '600');
      worldReadable(projectSettings, { hooks: {} });
      result = reconcileAssemblerSettingsFile({ zylosDir: zylos, apply: true });
      assert.equal(result.changed, true);
      assert.equal(mode(projectSettings), '600');
    });

    test('instruction migration creates its settings temporary file owner-only', () => {
      // The final chmod also restricts the file; this checks the temporary file is never created wider.
      const writes = [];
      const io = { writeFileSync: (file, content, options) => { writes.push({ file, options }); return fs.writeFileSync(file, content, options); } };
      const result = reconcileAssemblerSettingsFile({ zylosDir: zylos, apply: true, io });
      assert.equal(result.changed, true);
      const temporary = writes.filter(({ file }) => file.startsWith(`${projectSettings}.tmp.`));
      assert.equal(temporary.length, 1);
      assert.equal(temporary[0].options?.mode, 0o600);
    });

    test('instruction migration keeps the existing mode of non-settings files it rewrites', () => {
      const backupPath = path.join(root, 'migration-backup');
      fs.mkdirSync(backupPath, { recursive: true });
      const report = path.join(backupPath, 'migration-report.md');
      const baseReport = { classification: 'fixture', matched: null, candidates: [] };
      updateFailureReport({ backupPath, baseReport, failure: new Error('fixture failure') });
      assert.equal(mode(report), '644');
      fs.chmodSync(report, 0o640);
      updateFailureReport({ backupPath, baseReport, failure: new Error('fixture failure') });
      assert.equal(mode(report), '640');
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

    test('appending to an existing world-readable .env restricts it before the entries are written', t => {
      const envFile = path.join(zylos, '.env');
      fs.writeFileSync(envFile, 'TZ=UTC\n');
      fs.chmodSync(envFile, 0o644);
      assert.deepEqual(modesSeenByWrites(t, () => writeEnvEntries({ FIXTURE_TOKEN: 'credential-value-0014' }, 'fixture')), ['600']);
      assert.match(fs.readFileSync(envFile, 'utf8'), /^TZ=UTC\n[\s\S]*^FIXTURE_TOKEN=credential-value-0014$/m);
    });

    test('the credential file list names each runtime\'s own files', () => {
      assert.deepEqual(setup.credentialFiles('claude'), [userSettings, claudeJson]);
      assert.deepEqual(setup.credentialFiles('codex'), [codexAuth]);
    });

    // /dev/null is root-owned and writable by everyone: fchmod fails with EPERM, the write is harmless.
    // Never run as root, where fchmod would succeed and change the device node's mode.
    const devNull = (() => { try { return fs.statSync('/dev/null'); } catch { return null; } })();
    test('a writable file that cannot be restricted is still written without an error',
      { skip: !(devNull && process.getuid?.() !== 0 && devNull.uid !== process.getuid?.()) && 'needs a root-owned /dev/null and a non-root test user' }, () => {
        assert.doesNotThrow(() => writePrivateFile('/dev/null', 'x'));
        assert.equal(fs.statSync('/dev/null').mode, devNull.mode);
      });

    test('a symbolic link is followed: its target is written and tightened', () => {
      const target = path.join(root, 'link-target.json'), link = path.join(root, 'link.json');
      worldReadable(target, {});
      fs.symlinkSync(target, link);
      writePrivateFile(link, '{"written":true}\n');
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(mode(target), '600');
      assert.equal(readJson(target).written, true);
    });

    test('an own world-readable credential file is tightened and not reported', () => {
      worldReadable(userSettings, {});
      assert.deepEqual(checkPrivateFile(userSettings), { ok: true, mode: '600', fixed: true, previousMode: '644' });
      assert.deepEqual(setup.credentialFilePermissionWarnings(setup.credentialFiles('claude')), []);
    });

    // Real foreign-owned file: only checked, never written.
    const foreign = '/etc/hostname';
    const foreignStat = (() => { try { return fs.statSync(foreign); } catch { return null; } })();
    const foreignUsable = foreignStat && process.getuid?.() !== 0 && foreignStat.uid !== process.getuid?.()
      && (foreignStat.mode & 0o777) === 0o644;
    test('a foreign-owned 0644 file is reported with its real mode and left unchanged',
      { skip: !foreignUsable && `needs a root-owned 0644 ${foreign} and a non-root test user` }, () => {
        assert.deepEqual(checkPrivateFile(foreign), { ok: false, mode: '644', fixed: false });
        const warnings = setup.credentialFilePermissionWarnings([foreign]);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /mode 644/);
        assert.ok(warnings[0].includes(`chmod 600 ${foreign}`));
        const afterStat = fs.statSync(foreign);
        assert.equal(afterStat.mode, foreignStat.mode);
        assert.equal(afterStat.mtimeMs, foreignStat.mtimeMs);
      });
  });
});
