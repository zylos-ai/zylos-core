import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('review P2: SIGINT at the real auth CLI returns AUTH_CANCELLED/1 with one JSON line', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cancel-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'codex');
  fs.writeFileSync(binary, `#!${process.execPath}\nprocess.stderr.write('native-login-ready\\n');process.on('SIGINT',()=>process.exit(130));setInterval(()=>{},1000);\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [new URL('../../zylos.js', import.meta.url).pathname, 'auth', 'codex', '--json'], {
    env: { ...process.env, HOME: root, ZYLOS_DIR: path.join(root, 'zylos'), PATH: `${root}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', signalled = false;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => {
    stderr += data;
    if (!signalled && stderr.includes('native-login-ready')) { signalled = true; child.kill('SIGINT'); }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  assert.equal(signalled, true, stderr);
  assert.deepEqual(result, { code: 1, signal: null });
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.error.code, 'AUTH_CANCELLED');
  assert.equal(payload.error.configChanged, false);
  assert.equal(fs.existsSync(path.join(root, 'zylos/.zylos/config.json')), false);
});
