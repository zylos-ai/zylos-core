import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../runtime/claude.js';
import { resolveCodexBypassPermissions } from '../runtime-setup.js';
import { readEnvTimezone, needsBypassAcceptance, ensureWebConsolePassword } from '../../commands/init.js';
import { ZYLOS_DIR } from '../config.js';
import { readEnvFile, writeEnvEntries } from '../env.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotenv-readers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Claude auth probe uses dotenv values without contacting a runtime', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), [
    'ANTHROPIC_API_KEY=obsolete', 'export ANTHROPIC_API_KEY="fixture api # literal" # comment',
    "CLAUDE_CODE_OAUTH_TOKEN='fixture setup' # comment", 'export ANTHROPIC_BASE_URL=https://fixture.invalid # comment',
  ].join('\n'));
  let calls = 0;
  const adapter = new ClaudeAdapter({ root, env: { HOME: root, PATH: '/empty' }, execFile: async (_, __, { env }) => {
    calls++;
    assert.equal(env.ANTHROPIC_API_KEY, 'fixture api # literal');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture setup');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://fixture.invalid');
    return { stdout: 'ok' };
  } });
  assert.equal((await adapter.checkAuth()).status, 'success');
  assert.equal(calls, 1);
});

test('Codex permission preference uses dotenv and preserves explicit precedence', t => {
  const root = fixture(t);
  const previous = process.env.CODEX_BYPASS_PERMISSIONS;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BYPASS_PERMISSIONS;
    else process.env.CODEX_BYPASS_PERMISSIONS = previous;
  });
  delete process.env.CODEX_BYPASS_PERMISSIONS;
  fs.writeFileSync(path.join(root, '.env'), 'CODEX_BYPASS_PERMISSIONS=true\nexport CODEX_BYPASS_PERMISSIONS="false" # comment\n');
  assert.equal(resolveCodexBypassPermissions(root), false);
  assert.equal(resolveCodexBypassPermissions(root, { bypassPermissions: true }), true);
  process.env.CODEX_BYPASS_PERMISSIONS = 'true';
  assert.equal(resolveCodexBypassPermissions(root), true);
  delete process.env.CODEX_BYPASS_PERMISSIONS;
  fs.mkdirSync(path.join(root, 'unreadable'));
  fs.mkdirSync(path.join(root, 'unreadable', '.env'));
  assert.throws(() => resolveCodexBypassPermissions(path.join(root, 'unreadable')), { code: 'EISDIR' });
});

test('init reads timezone, bypass preference and existing password with dotenv', () => {
  fs.mkdirSync(ZYLOS_DIR, { recursive: true });
  const file = path.join(ZYLOS_DIR, '.env');
  assert.equal(fs.existsSync(file), false, 'runner provides a fresh isolated instance');
  try {
    fs.writeFileSync(file, [
      'TZ=obsolete', 'export TZ="UTC" # comment',
      'export CLAUDE_BYPASS_PERMISSIONS="false" # comment',
      'ZYLOS_WEB_PASSWORD=obsolete', "export ZYLOS_WEB_PASSWORD='fixture # password' # comment",
    ].join('\n'));
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(readEnvTimezone(), 'UTC');
    assert.equal(needsBypassAcceptance(), false);
    assert.equal(ensureWebConsolePassword(), 'fixture # password');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    fs.writeFileSync(file, 'export WEB_CONSOLE_PASSWORD="fixture legacy" # comment\n');
    assert.equal(ensureWebConsolePassword(), 'fixture legacy');
  } finally { fs.rmSync(file, { force: true }); }
});

test('environment entry writes recognize exported existing keys and remain append-only', () => {
  const file = path.join(ZYLOS_DIR, '.env');
  assert.equal(fs.existsSync(file), false);
  try {
    fs.writeFileSync(file, 'EXPORTED=first\nexport EXPORTED="last # literal" # comment\n');
    assert.equal(readEnvFile().get('EXPORTED'), 'last # literal');
    const before = fs.readFileSync(file, 'utf8');
    const result = writeEnvEntries({ EXPORTED: 'replacement' }, 'fixture');
    assert.deepEqual(result, { written: [], skipped: ['EXPORTED'] });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(file, { force: true }); }
});

// Integration boundary: load the real PM2 template with a fixture instance and
// installed Core on PATH; no PM2, tmux, runtime or database is started. Run when
// template dotenv reads or Core dependency resolution changes; skip otherwise.
// The runner isolates HOME, ZYLOS_DIR, PM2_HOME and TMPDIR before module loading.
for (const deployed of [false, true]) test(`PM2 template reads dotenv from an isolated instance with deployed layout ${deployed}`, t => {
  const root = fixture(t), bin = path.join(root, 'bin');
  const packageRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
  fs.mkdirSync(bin);
  fs.symlinkSync(fileURLToPath(new URL('../../zylos.js', import.meta.url)), path.join(bin, 'zylos'));
  fs.writeFileSync(path.join(root, '.env'), [
    'SYSTEM_PATH=/obsolete', `export SYSTEM_PATH="${bin}:/fixture/saved" # comment`,
    'CLAUDE_BYPASS_PERMISSIONS=true', 'export CLAUDE_BYPASS_PERMISSIONS="false" # comment',
    "export CODEX_BYPASS_PERMISSIONS='false' # comment",
  ].join('\n'));
  const before = { ZYLOS_DIR: process.env.ZYLOS_DIR, PATH: process.env.PATH, ZYLOS_PACKAGE_ROOT: process.env.ZYLOS_PACKAGE_ROOT };
  const require = createRequire(import.meta.url);
  let template = path.join(packageRoot, 'templates/pm2/ecosystem.config.cjs');
  if (deployed) {
    const skill = path.join(root, '.claude/skills/comm-bridge');
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(skill, '.zylos'));
    fs.copyFileSync(path.join(packageRoot, 'skills/comm-bridge/scripts/core-config-loader.js'), path.join(skill, 'scripts/core-config-loader.js'));
    fs.writeFileSync(path.join(skill, '.zylos/core-package.json'), JSON.stringify({ v: 1, packageRoot }));
    fs.mkdirSync(path.join(root, 'pm2'));
    fs.copyFileSync(template, path.join(root, 'pm2/ecosystem.config.cjs'));
    template = path.join(root, 'pm2/ecosystem.config.cjs');
  }
  try {
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key]?.startsWith('/dev/shm/') || process.env[key]?.includes('/zylos-tests-'), key);
    console.log('isolated PM2 template', JSON.stringify({ template, root, home: process.env.HOME, pm2: process.env.PM2_HOME, tmp: process.env.TMPDIR, tmux: 'not used', database: 'not used' }));
    process.env.ZYLOS_DIR = root;
    process.env.PATH = '/bin';
    delete process.env.ZYLOS_PACKAGE_ROOT;
    delete require.cache[template];
    const { apps } = require(template);
    const monitor = apps.find(app => app.name === 'activity-monitor');
    assert.equal(monitor.env.CLAUDE_BYPASS_PERMISSIONS, 'false');
    assert.equal(monitor.env.CODEX_BYPASS_PERMISSIONS, 'false');
    assert.equal(monitor.env.PATH.split(':').includes('/fixture/saved'), true);
    assert.equal(monitor.env.PATH.includes('/obsolete'), false);
    assert.equal(monitor.env.ZYLOS_PACKAGE_ROOT, packageRoot);
  } finally {
    delete require.cache[template];
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
