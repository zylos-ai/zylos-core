import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// .env holds API keys and passwords: every writer must leave it owner-only,
// and doctor must flag an existing file that other users can read.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-env-mode-'));
const originalEnv = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR };
const originalUmask = process.umask(0o022);
after(() => {
  process.umask(originalUmask);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
process.env.HOME = tmpRoot;
process.env.ZYLOS_DIR = path.join(tmpRoot, 'zylos');

const envFile = path.join(process.env.ZYLOS_DIR, '.env');
const mode = file => (fs.statSync(file).mode & 0o777).toString(8);
const posix = process.platform !== 'win32';

beforeEach(() => {
  fs.rmSync(process.env.ZYLOS_DIR, { recursive: true, force: true });
  fs.mkdirSync(process.env.ZYLOS_DIR, { recursive: true });
});

describe('.env file permissions', { skip: !posix && 'POSIX permission bits only' }, () => {
  test('component entries create a new .env readable by the owner only', async () => {
    const { writeEnvEntries } = await import('../env.js');
    writeEnvEntries({ TELEGRAM_BOT_TOKEN: 'token-value' }, 'telegram');
    assert.equal(mode(envFile), '600');
    assert.match(fs.readFileSync(envFile, 'utf8'), /TELEGRAM_BOT_TOKEN=token-value/);
  });

  test('component entries tighten an existing world-readable .env', async () => {
    const { writeEnvEntries } = await import('../env.js');
    fs.writeFileSync(envFile, 'TZ=Asia/Shanghai\n', { mode: 0o644 });
    fs.chmodSync(envFile, 0o644);
    writeEnvEntries({ LARK_APP_SECRET: 'secret-value' }, 'lark');
    assert.equal(mode(envFile), '600');
    assert.match(fs.readFileSync(envFile, 'utf8'), /TZ=Asia\/Shanghai[\s\S]*LARK_APP_SECRET=secret-value/);
  });

  test('rewriting .env creates it owner-only and tightens an existing file', async () => {
    const { writeEnvFile } = await import('../env.js');
    writeEnvFile(envFile, 'A=1\n');
    assert.equal(mode(envFile), '600');
    fs.chmodSync(envFile, 0o664);
    writeEnvFile(envFile, 'A=2\n');
    assert.equal(mode(envFile), '600');
    assert.equal(fs.readFileSync(envFile, 'utf8'), 'A=2\n');
  });

  test('a .env copied from a world-readable template is owner-only', async () => {
    const { copyEnvFile } = await import('../env.js');
    const template = path.join(tmpRoot, '.env.example');
    fs.writeFileSync(template, '# template\n');
    fs.chmodSync(template, 0o644);
    copyEnvFile(template, envFile);
    assert.equal(mode(envFile), '600');
    assert.equal(mode(template), '644');
  });

  test('saving the Anthropic API key leaves .env owner-only', async () => {
    const { saveApiKeyToEnv } = await import('../runtime-setup.js');
    fs.writeFileSync(envFile, 'TZ=UTC\n');
    fs.chmodSync(envFile, 0o644);
    saveApiKeyToEnv('sk-ant-api03-example');
    assert.equal(mode(envFile), '600');
    assert.match(fs.readFileSync(envFile, 'utf8'), /ANTHROPIC_API_KEY=sk-ant-api03-example/);
  });

  test('permission check reports group or other access and passes owner-only or missing files', async () => {
    const { checkEnvFilePermissions } = await import('../env.js');
    assert.deepEqual(checkEnvFilePermissions(envFile), { ok: true, exists: false, mode: null, checked: true });
    fs.writeFileSync(envFile, 'A=1\n');
    for (const [bits, ok] of [[0o644, false], [0o640, false], [0o604, false], [0o660, false], [0o600, true], [0o400, true]]) {
      fs.chmodSync(envFile, bits);
      const result = checkEnvFilePermissions(envFile);
      assert.equal(result.ok, ok, `mode ${bits.toString(8)}`);
      assert.equal(result.mode, bits.toString(8).padStart(3, '0'));
    }
    assert.equal(checkEnvFilePermissions(envFile, { platform: 'win32' }).checked, false);
  });

  test('doctor reports an .env other users can read and passes an owner-only one', async () => {
    const { buildDiagnosticJson } = await import('../../commands/doctor.js');
    const diag = envFile => ({ runtime: 'claude', display: 'Claude', apiHost: 'example.test',
      system: { tmux: { installed: true }, pm2: { installed: true, version: '6.0.0' }, network: { reachable: true }, envFile },
      ai: { cli: { installed: true }, auth: true, autonomous: true }, services: { running: false, procs: [] } });

    const open = buildDiagnosticJson(diag({ ok: false, exists: true, mode: '644', checked: true }), { success: false });
    const issue = open.issues.find(item => item.id === 'env_permissions');
    assert.ok(issue, 'env_permissions issue is reported');
    assert.match(issue.label, /mode 644/);
    assert.match(issue.hint, /chmod 600 ~\/zylos\/\.env/);
    assert.equal(open.groups.system.passed, false);
    assert.deepEqual(open.groups.system.checks.envFile, { ok: false, mode: '644' });

    const closed = buildDiagnosticJson(diag({ ok: true, exists: true, mode: '600', checked: true }), { success: false });
    assert.equal(closed.issues.some(item => item.id === 'env_permissions'), false);
    assert.equal(closed.groups.system.passed, true);
  });

  test('doctor collects the .env permission result', async () => {
    const { collectDiagnostics } = await import('../../commands/doctor.js');
    const reported = { ok: false, exists: true, mode: '644', checked: true };
    const diag = await collectDiagnostics({}, {
      resolve: async () => ({ runtime: 'unknown', sessionGroup: null, live: { tmuxName: 'zylos-test-none' } }),
      pm2Check: () => ({ installed: false }),
      envFileCheck: () => reported,
    });
    assert.equal(diag.system.envFile, reported);
  });
});
