import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// .env holds API keys and passwords: every writer must leave it owner-only,
// and doctor must flag an existing file that other users can read.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-env-mode-'));
const originalEnv = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };
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
// doctor probes tmux; keep it off the live server's socket.
process.env.TMUX_TMPDIR = tmpRoot;
delete process.env.TMUX;

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

  for (const [name, key, value] of [
    ['saveApiKeyToEnv', 'ANTHROPIC_API_KEY', 'sk-ant-api03-example'],
    ['saveSetupTokenToEnv', 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-example'],
    ['saveClaudeBaseUrlToSettingsAndEnv', 'ANTHROPIC_BASE_URL', 'https://relay.example.test'],
    ['saveCodexApiKeyToEnv', 'OPENAI_API_KEY', 'sk-openai-example'],
    ['saveCodexBaseUrlToEnv', 'OPENAI_BASE_URL', 'https://openai-relay.example.test/v1'],
  ]) {
    test(`${name} leaves .env owner-only`, async () => {
      const setup = await import('../runtime-setup.js');
      const saved = Object.fromEntries(['ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'].map(k => [k, process.env[k]]));
      try {
        fs.writeFileSync(envFile, 'TZ=UTC\n');
        fs.chmodSync(envFile, 0o644);
        setup[name](value);
        assert.equal(mode(envFile), '600');
        assert.match(fs.readFileSync(envFile, 'utf8'), new RegExp(`^${key}=${value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    });
  }

  test('init template deployment tightens an existing world-readable .env', () => {
    fs.writeFileSync(envFile, 'TZ=UTC\n');
    fs.chmodSync(envFile, 0o644);
    fs.mkdirSync(path.join(process.env.ZYLOS_DIR, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(process.env.ZYLOS_DIR, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude' }));
    const initModule = new URL('../../commands/init.js', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '--eval',
      `import { deployTemplates } from ${JSON.stringify(initModule)}; deployTemplates();`], {
      stdio: 'pipe', env: { ...process.env, HOME: tmpRoot, ZYLOS_DIR: process.env.ZYLOS_DIR },
    });
    assert.equal(mode(envFile), '600');
    assert.match(fs.readFileSync(envFile, 'utf8'), /^TZ=UTC$/m);
  });

  test('an own .env that others can access is tightened; owner-only, missing or broken files pass untouched', async () => {
    const { ensureEnvFilePrivate } = await import('../env.js');
    assert.deepEqual(ensureEnvFilePrivate(envFile), { ok: true, mode: null, fixed: false });
    fs.writeFileSync(envFile, 'A=1\n');
    for (const bits of [0o644, 0o640, 0o604, 0o660, 0o620]) {
      fs.chmodSync(envFile, bits);
      const previousMode = bits.toString(8);
      assert.deepEqual(ensureEnvFilePrivate(envFile), { ok: true, mode: '600', fixed: true, previousMode }, `mode ${previousMode}`);
      assert.equal(mode(envFile), '600');
    }
    fs.chmodSync(envFile, 0o400);
    assert.deepEqual(ensureEnvFilePrivate(envFile), { ok: true, mode: '400', fixed: false });
    assert.equal(fs.readFileSync(envFile, 'utf8'), 'A=1\n');

    const loop = path.join(process.env.ZYLOS_DIR, 'loop.env');
    fs.symlinkSync(loop, loop);
    assert.deepEqual(ensureEnvFilePrivate(loop), { ok: true, mode: null, fixed: false });
  });

  test('an .env that cannot be tightened is reported, without crashing or claiming a fix', async (t) => {
    const { ensureEnvFilePrivate } = await import('../env.js');
    fs.writeFileSync(envFile, 'A=1\n');
    fs.chmodSync(envFile, 0o644);
    const realChmod = fs.chmodSync;
    t.after(() => { fs.chmodSync = realChmod; });
    // A read-only mount rejects the change; some network filesystems accept it and keep the mode.
    for (const chmod of [() => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }); }, () => {}]) {
      fs.chmodSync = chmod;
      assert.deepEqual(ensureEnvFilePrivate(envFile), { ok: false, mode: '644', fixed: false });
    }
    fs.chmodSync = realChmod;
    assert.equal(mode(envFile), '644');
  });

  test('an .env owned by another user is reported, not changed', async () => {
    const { ensureEnvFilePrivate } = await import('../env.js');
    fs.writeFileSync(envFile, 'A=1\n');
    fs.chmodSync(envFile, 0o644);
    const otherUid = fs.statSync(envFile).uid + 1;
    assert.deepEqual(ensureEnvFilePrivate(envFile, { uid: otherUid }), { ok: false, mode: '644', fixed: false });
    assert.equal(mode(envFile), '644');
    assert.deepEqual(ensureEnvFilePrivate(envFile, { platform: 'win32' }), { ok: true, mode: null, fixed: false });
    assert.equal(mode(envFile), '644');
  });

  test('doctor fails on an .env it could not tighten and passes a tightened one', async () => {
    const { buildDiagnosticJson } = await import('../../commands/doctor.js');
    const diag = envFile => ({ runtime: 'claude', display: 'Claude', apiHost: 'example.test',
      system: { tmux: { installed: true }, pm2: { installed: true, version: '6.0.0' }, network: { reachable: true }, envFile },
      ai: { cli: { installed: true }, auth: true, autonomous: true }, services: { running: false, procs: [] } });

    const open = buildDiagnosticJson(diag({ ok: false, mode: '644', fixed: false }), { success: false });
    const issue = open.issues.find(item => item.id === 'env_permissions');
    assert.ok(issue, 'env_permissions issue is reported');
    assert.match(issue.label, /mode 644/);
    assert.ok(issue.hint.includes(`chmod 600 ${envFile}`));
    assert.ok(issue.label.startsWith(envFile));
    assert.equal(open.groups.system.passed, false);
    assert.deepEqual(open.groups.system.checks.envFile, { ok: false, mode: '644', fixed: false });

    const fixed = buildDiagnosticJson(diag({ ok: true, mode: '600', fixed: true, previousMode: '644' }), { success: false });
    assert.equal(fixed.issues.some(item => item.id === 'env_permissions'), false);
    assert.equal(fixed.groups.system.passed, true);
    assert.deepEqual(fixed.groups.system.checks.envFile, { ok: true, mode: '600', fixed: true });
  });

  test('doctor tightens an own world-readable .env while collecting diagnostics', async () => {
    const { collectDiagnostics } = await import('../../commands/doctor.js');
    fs.writeFileSync(envFile, 'A=1\n');
    fs.chmodSync(envFile, 0o644);
    const diag = await collectDiagnostics({}, {
      resolve: async () => ({ runtime: 'unknown', sessionGroup: null, live: { tmuxName: 'zylos-test-none' } }),
      pm2Check: () => ({ installed: false }),
    });
    assert.deepEqual(diag.system.envFile, { ok: true, mode: '600', fixed: true, previousMode: '644' });
    assert.equal(mode(envFile), '600');
  });
});
