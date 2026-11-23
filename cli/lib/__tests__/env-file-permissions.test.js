import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  test('rewriting .env creates it owner-only and tightens an existing file', async () => {
    const { writeEnvFile } = await import('../env.js');
    writeEnvFile(envFile, 'A=1\n');
    assert.equal(mode(envFile), '600');
    fs.chmodSync(envFile, 0o664);
    writeEnvFile(envFile, 'A=2\n');
    assert.equal(mode(envFile), '600');
    assert.equal(fs.readFileSync(envFile, 'utf8'), 'A=2\n');
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

});
