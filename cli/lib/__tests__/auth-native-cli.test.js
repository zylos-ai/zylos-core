import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('review P2: SIGINT at the real auth CLI returns AUTH_CANCELLED/1 with one JSON line', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cancel-cli-'));
  for (const runtime of ['claude', 'codex']) {
    const script = runtime === 'codex'
      ? "process.stderr.write('codex-native-login-ready\\n');process.on('SIGINT',()=>process.exit(130));setInterval(()=>{},1000);"
      : "process.stderr.write('unexpected-claude-login\\n');process.exit(72);";
    fs.writeFileSync(path.join(root, runtime), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(root, 'which'), `#!${process.execPath}\nimport path from 'node:path';const name=process.argv[2];if(!['claude','codex'].includes(name))process.exit(1);console.log(path.join(process.env.HOME,name));\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [new URL('../../zylos.js', import.meta.url).pathname, 'auth', 'codex', '--json'], {
    env: { HOME: root, ZYLOS_DIR: path.join(root, 'zylos'), PATH: root },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const killGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let stdout = '', stderr = '', signalled = false, timedOut = false;
  // Kill the owned group and release pipes even if CLI signal forwarding regresses.
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup('SIGKILL');
    child.stdout.destroy(); child.stderr.destroy();
  }, 5000);
  t.after(() => {
    clearTimeout(timer);
    killGroup('SIGKILL');
    child.stdout.destroy(); child.stderr.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => {
    stderr += data;
    if (!signalled && stderr.includes('codex-native-login-ready')) { signalled = true; child.kill('SIGINT'); }
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  assert.equal(timedOut, false, 'auth CLI exceeded its bounded fixture deadline');
  assert.doesNotMatch(stderr, /unexpected-claude-login/);
  assert.equal(signalled, true, stderr);
  assert.deepEqual(result, { code: 1, signal: null });
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.error.code, 'AUTH_CANCELLED');
  assert.equal(payload.error.configChanged, false);
  assert.equal(fs.existsSync(path.join(root, 'zylos/.zylos/config.json')), false);
});
