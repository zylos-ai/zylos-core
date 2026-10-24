import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

// tmux passes client stdio descriptors to its server. Killing only the client
// leaves those pipes open while the server is frozen, keeping Node alive.
test('connection timeout releases stdio and exits before a frozen server resumes', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p02-connection-timeout-'));
  const socketPath = path.join(dir, 'tmux.sock');
  const binary = process.env.TEST_TMUX_BIN || 'tmux';
  const tmux = (...args) => execFileSync(binary, ['-S', socketPath, ...args], {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  let server, child, exited;
  t.after(async () => {
    if (server) try { process.kill(server, 'SIGCONT'); } catch {}
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (exited) await exited;
    try { tmux('kill-server'); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', 'sleep', '30');
  server = Number(tmux('display-message', '-p', '#{pid}'));
  process.kill(server, 'SIGSTOP');
  const moduleUrl = new URL('../tmux-connection.js', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { openTmuxConnection } from ${JSON.stringify(moduleUrl)};
    await assert.rejects(openTmuxConnection(${JSON.stringify({ socketPath, binary, timeoutMs: 200 })}),
      { code: 'TMUX_UNAVAILABLE', cause: 'timeout' });
    console.log('timeout-rejected');
  `;
  const started = performance.now();
  child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let deadline;
  const result = await Promise.race([
    exited,
    new Promise(resolve => { deadline = setTimeout(() => resolve(null), 2500); }),
  ]).finally(() => clearTimeout(deadline));
  assert.match(stdout, /timeout-rejected/, `connection did not reject as expected: ${stderr}`);
  assert.notEqual(result, null, 'child retained tmux stdio after its timeout while server stayed frozen');
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.match(execFileSync('ps', ['-o', 'stat=', '-p', String(server)], { encoding: 'utf8' }).trim(), /^T/,
    'server must still be stopped when the caller exits');
  t.diagnostic(`caller exited in ${Math.round(performance.now() - started)}ms with server still stopped`);
});
