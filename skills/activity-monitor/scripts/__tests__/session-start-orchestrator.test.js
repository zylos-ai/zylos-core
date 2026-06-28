import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  installProcessBackstop,
  readStdinPayload,
  runSessionStartOrchestrator,
  runStep,
  writeAllSync,
} from '../session-start-orchestrator.js';
import { enqueueStartupPrompt } from '../session-start-prompt.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const C4_SESSION_INIT = path.resolve(SCRIPT_DIR, '../../../comm-bridge/scripts/c4-session-init.js');
const SESSION_START_PROMPT = path.resolve(SCRIPT_DIR, '../session-start-prompt.js');

function tempStdout() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-orch-'));
  const filePath = path.join(tmpDir, 'stdout.txt');
  const fd = fs.openSync(filePath, 'w+');
  return {
    stdout: { fd },
    read() {
      fs.closeSync(fd);
      return fs.readFileSync(filePath, 'utf8');
    },
    cleanup() {
      try { fs.closeSync(fd); } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function actions(overrides = {}) {
  const calls = [];
  return {
    calls,
    actions: {
      memoryInject: async (payload) => {
        calls.push(['memory', payload.source]);
        return 'MEM\n';
      },
      c4SessionInit: async (payload) => {
        calls.push(['c4', payload.source]);
        return 'C4\n';
      },
      foreground: async (payload) => {
        calls.push(['foreground', payload.source]);
      },
      startupPrompt: async (payload) => {
        calls.push(['prompt', payload.source]);
      },
      ...overrides,
    },
  };
}

async function runWithActions(source, overrides = {}, options = {}) {
  const out = tempStdout();
  const harness = actions(overrides);
  try {
    await runSessionStartOrchestrator({ source, session_id: 's1' }, {
      stdout: out.stdout,
      totalBudgetMs: 1000,
      budgets: {
        memoryInject: 50,
        c4SessionInit: 50,
        foreground: 50,
        startupPrompt: 50,
      },
      actions: harness.actions,
      ...options,
    });
    return { calls: harness.calls, stdout: out.read() };
  } finally {
    out.cleanup();
  }
}

describe('session-start-orchestrator', () => {
  it('runs startup source with all four steps', async () => {
    const result = await runWithActions('startup');
    assert.deepEqual(result.calls, [
      ['memory', 'startup'],
      ['c4', 'startup'],
      ['foreground', 'startup'],
      ['prompt', 'startup'],
    ]);
    assert.equal(result.stdout, 'MEM\nC4\n');
  });

  it('runs clear source with all four steps', async () => {
    const result = await runWithActions('clear');
    assert.deepEqual(result.calls.map(([name]) => name), ['memory', 'c4', 'foreground', 'prompt']);
  });

  it('runs compact source without prompt enqueue', async () => {
    const result = await runWithActions('compact');
    assert.deepEqual(result.calls.map(([name]) => name), ['memory', 'c4', 'foreground']);
    assert.equal(result.stdout, 'MEM\nC4\n');
  });

  it('preserves stdout byte order as memory then C4', async () => {
    const result = await runWithActions('startup', {
      memoryInject: async () => 'A',
      c4SessionInit: async () => 'B',
    });
    assert.equal(result.stdout, 'AB');
  });

  it('does not write stdout for failed memory step', async () => {
    const result = await runWithActions('startup', {
      memoryInject: async () => { throw new Error('memory failed'); },
    });
    assert.equal(result.stdout, 'C4\n');
    assert.deepEqual(result.calls.map(([name]) => name), ['c4', 'foreground', 'prompt']);
  });

  it('does not write stdout for failed C4 step', async () => {
    const result = await runWithActions('startup', {
      c4SessionInit: async () => { throw new Error('c4 failed'); },
    });
    assert.equal(result.stdout, 'MEM\n');
    assert.deepEqual(result.calls.map(([name]) => name), ['memory', 'foreground', 'prompt']);
  });

  it('continues when foreground side effect fails', async () => {
    const result = await runWithActions('startup', {
      foreground: async () => { throw new Error('foreground failed'); },
    });
    assert.equal(result.stdout, 'MEM\nC4\n');
    assert.deepEqual(result.calls.map(([name]) => name), ['memory', 'c4', 'prompt']);
  });

  it('continues when prompt side effect fails', async () => {
    const result = await runWithActions('startup', {
      startupPrompt: async () => { throw new Error('prompt failed'); },
    });
    assert.equal(result.stdout, 'MEM\nC4\n');
    assert.deepEqual(result.calls.map(([name]) => name), ['memory', 'c4', 'foreground']);
  });

  it('times out async signal-style step bodies without blocking later steps', async () => {
    const result = await runWithActions('startup', {
      memoryInject: () => new Promise(() => {}),
    });
    assert.equal(result.stdout, 'C4\n');
    assert.deepEqual(result.calls.map(([name]) => name), ['c4', 'foreground', 'prompt']);
  });

  it('continues when a dynamic-import-style step fails before producing context', async () => {
    const result = await runWithActions('startup', {
      memoryInject: async () => {
        const err = new Error('Cannot find module');
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      },
    });
    assert.equal(result.stdout, 'C4\n');
    assert.deepEqual(result.calls.map(([name]) => name), ['c4', 'foreground', 'prompt']);
  });

  it('runStep records successful stdout writes', async () => {
    const out = tempStdout();
    try {
      const result = await runStep({
        name: 'unit',
        source: 'startup',
        budgetMs: 50,
        action: async () => 'payload',
        writeStdout: true,
        stdout: out.stdout,
      });
      assert.equal(result.ok, true);
      assert.equal(out.read(), 'payload');
    } finally {
      out.cleanup();
    }
  });

  it('writeAllSync retries short writes and EAGAIN until the full buffer is written', () => {
    const chunks = [];
    let calls = 0;
    const written = writeAllSync(1, 'abcdef', {
      writeSync: (fd, buffer, offset, length) => {
        assert.equal(fd, 1);
        calls++;
        if (calls === 2) {
          const err = new Error('temporarily unavailable');
          err.code = 'EAGAIN';
          throw err;
        }
        const size = Math.min(2, length);
        chunks.push(buffer.toString('utf8', offset, offset + size));
        return size;
      },
    });

    assert.equal(written, 6);
    assert.equal(chunks.join(''), 'abcdef');
    assert.equal(calls, 4);
  });

  it('writes payloads larger than pipe buffers without truncation', () => {
    const payloadLength = 150 * 1024;
    const script = `
      import { runStep } from ${JSON.stringify(path.resolve(SCRIPT_DIR, '../session-start-orchestrator.js'))};
      await runStep({
        name: 'large',
        source: 'startup',
        budgetMs: 1000,
        action: async () => 'x'.repeat(${payloadLength}),
        writeStdout: true,
      });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      maxBuffer: payloadLength + 64 * 1024,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.length, payloadLength);
    assert.equal(result.stdout, 'x'.repeat(payloadLength));
  });

  it('runStep reports timeout failures', async () => {
    const result = await runStep({
      name: 'unit-timeout',
      source: 'startup',
      budgetMs: 5,
      action: () => new Promise(() => {}),
    });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /timed out/);
  });

  it('readStdinPayload pauses and unrefs stdin when the read times out', async () => {
    const calls = [];
    const stdin = {
      setEncoding: encoding => calls.push(['setEncoding', encoding]),
      on: event => calls.push(['on', event]),
      off: event => calls.push(['off', event]),
      pause: () => calls.push(['pause']),
      unref: () => calls.push(['unref']),
    };

    const payload = await readStdinPayload({ stdin, timeoutMs: 5 });

    assert.deepEqual(payload, {});
    assert.ok(calls.some(call => call[0] === 'pause'));
    assert.ok(calls.some(call => call[0] === 'unref'));
  });

  it('passes a hard timeout and kill signal to prompt child process', () => {
    const calls = [];
    enqueueStartupPrompt('startup', {
      controlPath: '/tmp/c4-control.js',
      childTimeoutMs: 1234,
      execFile: (...args) => calls.push(args),
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], 'node');
    assert.deepEqual(calls[0][1].slice(0, 2), ['/tmp/c4-control.js', 'enqueue']);
    assert.equal(calls[0][2].timeout, 1234);
    assert.equal(calls[0][2].killSignal, 'SIGKILL');
  });

  it('awaits the prompt child asynchronously (genuinely parallelizable)', async () => {
    let resolveChild;
    let settled = false;
    const pending = enqueueStartupPrompt('startup', {
      controlPath: '/tmp/c4-control.js',
      execFile: () => new Promise((resolve) => { resolveChild = resolve; }),
    }).then(() => { settled = true; });

    // The async child has not resolved yet → enqueue must still be pending,
    // proving it does not block synchronously like the old execFileSync.
    await Promise.resolve();
    assert.equal(settled, false);
    resolveChild();
    await pending;
    assert.equal(settled, true);
  });

  it('imports c4-session-init without CLI side effects', () => {
    const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(C4_SESSION_INIT)})`], {
      env: { ...process.env, ZYLOS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'c4-import-')) },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  it('imports session-start-prompt without CLI side effects', () => {
    const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(SESSION_START_PROMPT)})`], {
      env: { ...process.env, ZYLOS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-import-')) },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  it('happy path returns quickly instead of waiting for the backstop', async () => {
    const start = Date.now();
    await runWithActions('startup');
    assert.ok(Date.now() - start < 500);
  });

  it('process backstop can force a clean exit after the total budget', async () => {
    let exitCode = null;
    const timer = installProcessBackstop({
      totalBudgetMs: 5,
      exit: (code) => { exitCode = code; },
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(exitCode, 0);
    } finally {
      clearTimeout(timer);
    }
  });

  it('runSessionStartOrchestrator can use a caller-owned hard backstop timer', async () => {
    const timer = installProcessBackstop({
      totalBudgetMs: 1000,
      exit: () => { throw new Error('should not exit'); },
    });
    try {
      const result = await runWithActions('startup', {}, { hardBackstopTimer: timer });
      assert.equal(result.stdout, 'MEM\nC4\n');
    } finally {
      clearTimeout(timer);
    }
  });

  it('caller-owned hard backstop can fire while orchestration is still running', async () => {
    let exitCode = null;
    const timer = installProcessBackstop({
      totalBudgetMs: 5,
      exit: (code) => { exitCode = code; },
    });
    try {
      await runWithActions('startup', {
        memoryInject: async () => {
          await new Promise(resolve => setTimeout(resolve, 25));
          return 'late';
        },
      }, {
        hardBackstopTimer: timer,
        budgets: {
          memoryInject: 100,
          c4SessionInit: 50,
          foreground: 50,
          startupPrompt: 50,
        },
      });
      assert.equal(exitCode, 0);
    } finally {
      clearTimeout(timer);
    }
  });
});
