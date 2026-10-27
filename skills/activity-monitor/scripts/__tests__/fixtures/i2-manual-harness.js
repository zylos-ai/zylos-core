import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../../test/helpers/ready-tmux-target.js';
import { submit } from '../../../../../cli/lib/am-sock-client.js';
const worker = fileURLToPath(new URL('./i2-manual-worker.js', import.meta.url));
export function fixture(t, mode = 'multi', runtime = 'claude') {
  const f = readyTmuxTarget(t, { prefix: 'i2mr-', mode, runtime, runtimeProcess: true });
  f.tmux('new-session', '-d', '-s', 'fixture-keeper', 'sleep', '120');
  if (runtime === 'codex') {
    fs.copyFileSync(path.join(f.root, 'claude'), path.join(f.root, 'codex'));
    fs.chmodSync(path.join(f.root, 'codex'), 0o700);
    f.tmux('respawn-pane', '-k', '-t', 'zylos-group-origin:0.0', path.join(f.root, 'codex'), '120');
  }
  return { ...f, mode, runtime, submit: request => submit(request, { socketPath: path.join(f.root, 'activity-monitor/am.sock'), deadlineAt: Date.now() + 10000 }) };
}
export function launch(t, f, variant = '') {
  const child = fork(worker, [f.socketPath, f.binary, f.mode, variant], { env: { ...process.env, ...f.env }, silent: true });
  let stderr = ''; child.stderr.on('data', data => stderr += data);
  const inbox = [], waiters = [];
  child.on('message', value => waiters.length ? waiters.shift().resolve(value) : inbox.push(value));
  child.on('exit', (code, signal) => { for (const waiter of waiters.splice(0)) waiter.reject(new Error(`M4 exited ${code ?? signal}: ${stderr}`)); });
  const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); assert.equal((await done)[1], 'SIGKILL'); } };
  t.after(kill);
  return { child, next, kill, async command(value) { child.send(value); const result = await next(); assert.equal(result.error, undefined); return result; },
    async stop() { const done = once(child, 'exit'); child.send('stop'); assert.deepEqual(await next(), { stopped: true }); assert.equal((await done)[0], 0); } };
}
export const manual = (requestId, extra = {}) => ({ version: 1, type: 'manual_restart', requestId, ...extra });
export function assertReply(reply, request, result, extra = {}, ok = true) {
  assert.deepEqual(reply.reply, { version: 1, type: 'manual_restart', requestId: request.requestId, ok, result, ...extra });
}
