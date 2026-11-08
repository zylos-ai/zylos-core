import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INITIALIZATION_NOTICE, printInitializationNotice } from '../postinstall-notice.js';

const driver = fileURLToPath(new URL('./helpers/postinstall-notice-child.js', import.meta.url));
const dirs = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-notice-'));
  dirs.push(dir);
  return dir;
}
function run(ttyPath) {
  return execFileSync(process.execPath, [driver, ttyPath], {
    encoding: 'utf8', timeout: 5000, detached: true, stdio: 'pipe',
  });
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('writes exactly one notice to an available terminal path without a stdout duplicate', () => {
  const ttyPath = path.join(fixture(), 'terminal');
  fs.writeFileSync(ttyPath, '');
  assert.equal(run(ttyPath), '');
  assert.equal(fs.readFileSync(ttyPath, 'utf8'), INITIALIZATION_NOTICE);
  assert.match(INITIALIZATION_NOTICE, /"zylos init"/);
  assert.match(INITIALIZATION_NOTICE, /"zylos upgrade --self"/);
});

it('silently retains stdout and exits zero when the terminal path is absent', () => {
  const ttyPath = path.join(fixture(), 'absent');
  assert.equal(run(ttyPath), INITIALIZATION_NOTICE);
  assert.equal(fs.existsSync(ttyPath), false);
});

it('silently retains stdout and exits zero when the terminal cannot be opened for writing', () => {
  assert.equal(run(fixture()), INITIALIZATION_NOTICE);
});

it('silently retains stdout and exits zero when the terminal write fails', {
  skip: !fs.existsSync('/dev/full'),
}, () => {
  assert.equal(run('/dev/full'), INITIALIZATION_NOTICE);
});

it('writes once to foreground stdout without also opening the terminal path', () => {
  const ttyPath = path.join(fixture(), 'terminal');
  fs.writeFileSync(ttyPath, '');
  const writes = [];
  printInitializationNotice({ stdout: { isTTY: true, write: text => writes.push(text) }, ttyPath });
  assert.equal(writes.length, 1);
  assert.equal(writes[0], INITIALIZATION_NOTICE);
  assert.equal(fs.readFileSync(ttyPath, 'utf8'), '');
});

it('does not wait for a reader when the injected terminal path is a FIFO', {
  skip: !fs.existsSync('/usr/bin/mkfifo'),
}, () => {
  const ttyPath = path.join(fixture(), 'terminal');
  execFileSync('/usr/bin/mkfifo', [ttyPath], { timeout: 5000 });
  assert.equal(run(ttyPath), INITIALIZATION_NOTICE);
});
