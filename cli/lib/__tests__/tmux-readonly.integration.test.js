import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTmuxSender, parseTmuxVersion } from '../../../skills/comm-bridge/scripts/tmux-send-keys.js';

const binary = process.env.ZYLOS_TEST_TMUX || 'tmux';
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (check()) return; await sleep(50); }
  assert.fail(`Timed out waiting for ${label}`);
}

test('tmux >= 3.7 delivers Enter and Escape alongside a read-only client', { timeout: 20000 }, async t => {
  let version;
  try { version = parseTmuxVersion(execFileSync(binary, ['-V'], { encoding: 'utf8', timeout: 3000 })); }
  catch (error) {
    if (error.code === 'ENOENT') return t.skip(`tmux unavailable: ${binary}`);
    throw error;
  }
  if (version.version === 'unknown') assert.fail(`Cannot parse ${binary} -V`);
  if (version.major < 3 || (version.major === 3 && version.minor < 7)) return t.skip(`requires tmux >= 3.7; found ${version.version}`);
  if (process.platform !== 'linux') return t.skip('read-only PTY setup requires Linux util-linux script');
  const scriptVersion = execFileSync('script', ['--version'], { encoding: 'utf8', timeout: 3000 });
  assert.match(scriptVersion, /util-linux/, 'requires util-linux script on Linux');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-tmux-readonly-'));
  const prefix = ['-L', `zylos-test-${process.pid}-${Date.now()}`, '-f', '/dev/null'];
  const run = args => execFileSync(binary, [...prefix, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  let client;
  const sink = path.join(dir, 'bytes');
  const ready = path.join(dir, 'ready');
  const receiver = path.join(dir, 'receive.cjs');
  fs.writeFileSync(receiver, `const fs = require('fs'); process.stdin.setRawMode(true); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); process.stdin.on('data', b => fs.appendFileSync(${JSON.stringify(sink)}, b));`);
  try {
    run(['new-session', '-d', '-s', 'target', `${quote(process.execPath)} ${quote(receiver)}`]);
    await until(() => fs.existsSync(ready), 'raw pane receiver');
    client = spawn('script', ['-q', '-c', [binary, ...prefix, 'attach-session', '-r', '-t', 'target'].map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, TERM: 'xterm', TMUX: '' }, stdio: ['pipe', 'ignore', 'pipe']
    });
    let setupError = ''; client.stderr.on('data', b => { setupError += b; });
    await until(() => {
      assert.equal(client.exitCode, null, `read-only attach exited: ${setupError}`);
      return run(['list-clients', '-F', '#{client_readonly}']).trim().split('\n').includes('1');
    }, 'read-only client');
    // Negative control uses exactly the old argv and must fail before any bytes arrive.
    for (const key of ['Enter', 'Escape']) {
      assert.throws(() => run(['send-keys', '-t', 'target', key]), error => error.status === 1 && /client is read-only/.test(String(error.stderr)));
    }
    assert.equal(fs.existsSync(sink) ? fs.readFileSync(sink).length : 0, 0);
    const sender = createTmuxSender({ binary, prefix });
    sender.sendKeys('target', ['Enter'], { timeout: 3000, stdio: 'pipe' });
    sender.sendKeys('target', ['Escape'], { timeout: 3000, stdio: 'pipe' });
    await until(() => fs.existsSync(sink) && fs.statSync(sink).size >= 2, 'Enter/Escape bytes');
    assert.deepEqual(fs.readFileSync(sink), Buffer.from([0x0d, 0x1b]));
  } finally {
    try { run(['kill-server']); } catch { /* isolated server may already be gone */ }
    if (client) { client.stdin.destroy(); client.kill('SIGTERM'); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
