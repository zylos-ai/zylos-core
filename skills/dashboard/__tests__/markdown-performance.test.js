import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('./helpers/markdown-performance-worker.js', import.meta.url));
const sizes = [524288, 1048576, 2097152];
const patterns = ['continuous-stars', 'alternating-openers', 'unmatched-punctuation'];
const mib = 1048576;
// Ten seconds per MiB leaves room for shared/slow CI hosts while rejecting
// pathological parsing. A parent timer can stop a synchronously stuck parser.
const renderLimitMs = bytes => 10000 * bytes / mib;

function privateEnvironment() {
  const realHome = fs.realpathSync(os.userInfo().homedir);
  const home = fs.realpathSync(process.env.HOME);
  const instance = fs.realpathSync(process.env.ZYLOS_DIR);
  const temporary = fs.realpathSync(process.env.TMPDIR);
  assert.ok(!home.startsWith(realHome + path.sep) && home !== realHome, 'use the official isolated test runner');
  assert.equal(instance, path.join(home, 'zylos'));
  assert.equal(process.env.PM2_HOME, path.join(home, '.pm2'));
  assert.equal(temporary, path.join(path.dirname(home), 'tmp'));
  const root = fs.mkdtempSync(path.join(temporary, 'md-'));
  const env = { LANG: 'C.UTF-8' };
  for (const [key, leaf] of [['HOME', 'home'], ['ZYLOS_DIR', 'instance'], ['PM2_HOME', 'pm2'], ['TMPDIR', 'tmp']]) {
    env[key] = path.join(root, leaf);
    fs.mkdirSync(env[key]);
    assert.equal(fs.realpathSync(env[key]), env[key]);
  }
  assert.ok(Buffer.byteLength(path.join(root, 'tmux.sock')) < 100, 'temporary path stays short');
  return { root, env };
}

async function measure(t, sandbox, pattern, bytes) {
  const execArgv = ['--max-old-space-size=1536', '--expose-gc'];
  console.info('markdown performance child targets', JSON.stringify({ pattern, bytes,
    ...sandbox.env, cwd: sandbox.root, execArgv, services: 0, databases: 0, sockets: 0 }));
  const child = fork(helper, [pattern, String(bytes)], {
    cwd: sandbox.root, env: sandbox.env, execArgv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const abort = () => child.kill('SIGKILL');
  t.signal.addEventListener('abort', abort, { once: true });
  let deadline, result, failure, messages = 0, nextSample = 0, rendering = false;
  let rejectRun;
  const arm = milliseconds => {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      abort();
      rejectRun(new Error(`Markdown ${pattern} ${bytes} byte worker exceeded its parent deadline`));
    }, milliseconds);
  };
  try {
    const run = new Promise((resolve, reject) => {
      rejectRun = reject;
      child.once('error', reject);
      child.on('message', message => {
        try {
          assert.ok(++messages <= 9, 'worker protocol stays bounded');
          assert.ok(JSON.stringify(message).length < 4096, 'worker result stays bounded');
          if (message.type === 'ready') {
            for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.equal(message.isolation[key], sandbox.env[key]);
            assert.equal(message.cwd, sandbox.root);
            assert.equal(message.execArgv.join(' '), execArgv.join(' '));
            console.info('markdown performance child readback', JSON.stringify(message));
            child.send('render');
          } else if (message.type === 'sample-start') {
            assert.equal(rendering, false);
            assert.equal(message.sample, nextSample);
            rendering = true;
            arm(renderLimitMs(bytes) + 500);
          } else if (message.type === 'sample-done') {
            assert.equal(rendering, true);
            assert.ok(Number.isFinite(message.elapsedMs) && message.elapsedMs >= 0 &&
              message.elapsedMs <= renderLimitMs(bytes), 'each render finishes within its time budget');
            assert.equal(message.sample, nextSample++);
            rendering = false;
            arm(10000);
          } else if (message.type === 'result') {
            assert.equal(nextSample, 3);
            assert.equal(rendering, false);
            assert.equal(message.pattern, pattern);
            assert.equal(message.bytes, bytes);
            assert.equal(message.samplesMs.length, 3);
            for (const ms of message.samplesMs) assert.ok(Number.isFinite(ms) && ms >= 0 && ms <= renderLimitMs(bytes), 'each render finishes within its time budget');
            result = message;
          } else if (message.type === 'failure') {
            throw new Error(message.message);
          } else throw new Error('unexpected worker message');
        } catch (error) { failure = error; abort(); reject(error); }
      });
      closed.then(({ code, signal }) => {
        if (failure) reject(failure);
        else if (code !== 0 || signal || !result) reject(new Error(`Markdown worker failed: code=${code} signal=${signal}`));
        else resolve(result);
      });
      arm(10000);
    });
    return await run;
  } finally {
    clearTimeout(deadline);
    t.signal.removeEventListener('abort', abort);
    abort();
    await closed;
  }
}

// Pure rendering boundary: run when the shipped parser, CJK plugin or Memory
// renderer changes; unrelated UI/service changes may skip. The official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR, and each worker reads its private paths
// back before rendering. No service, DB, tmux or network is used. Every child,
// timer and private directory is reclaimed on success/failure/timeout.
for (const pattern of patterns) {
  test(`Memory Markdown renders large ${pattern} input within a bounded time`, { timeout: 240000 }, async t => {
    const sandbox = privateEnvironment();
    try {
      const rows = [];
      for (const bytes of sizes) {
        const result = await measure(t, sandbox, pattern, bytes);
        const sorted = [...result.samplesMs].sort((a, b) => a - b);
        rows.push({ bytes, samplesMs: result.samplesMs.map(ms => Number(ms.toFixed(3))),
          medianMs: Number(sorted[1].toFixed(3)), outputCharacters: result.outputCharacters });
      }
      // Timings document empirical growth rather than asserting a flaky ratio:
      // scheduler/GC noise does not prove or disprove algorithmic complexity.
      console.info('markdown performance growth', JSON.stringify({ pattern, rows,
        doublingRatios: [rows[1].medianMs / rows[0].medianMs, rows[2].medianMs / rows[1].medianMs]
          .map(value => Number(value.toFixed(3))) }));
    } finally { fs.rmSync(sandbox.root, { recursive: true, force: true }); }
  });
}
