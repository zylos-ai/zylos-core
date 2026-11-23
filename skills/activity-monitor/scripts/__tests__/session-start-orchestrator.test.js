import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  runSessionStartOrchestrator,
} from '../session-start-orchestrator.js';
import { CORE_SHARDS } from '../shard-registry.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

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
  // The orchestrator unrefs its budget timers on purpose (a hook process
  // must never be kept alive by its own watchdogs). Tests that feed it
  // never-settling promises therefore need SOMETHING ref'd on the event
  // loop, or the loop drains before the unref'd timeout can fire and the
  // runner cancels the remaining tests. A ref'd keep-alive interval
  // restores deterministic timer delivery without touching production
  // semantics.
  let keepAlive;
  before(() => { keepAlive = setInterval(() => {}, 1000); });
  after(() => clearInterval(keepAlive));

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

  it('runs compact source without prompt enqueue', async () => {
    const result = await runWithActions('compact');
    assert.deepEqual(result.calls.map(([name]) => name), ['memory', 'c4', 'foreground']);
    assert.equal(result.stdout, 'MEM\nC4\n');
  });

  it('continues when foreground side effect fails', async () => {
    const result = await runWithActions('startup', {
      foreground: async () => { throw new Error('foreground failed'); },
    });
    assert.equal(result.stdout, 'MEM\nC4\n');
    assert.deepEqual(result.calls.map(([name]) => name), ['memory', 'c4', 'prompt']);
  });

  it('times out async signal-style step bodies without blocking later steps', async () => {
    const result = await runWithActions('startup', {
      memoryInject: () => new Promise(() => {}),
    });
    assert.match(result.stdout, /=== MEMORY-INJECT UNAVAILABLE ===/);
    assert.match(result.stdout, /timed out/);
    assert.ok(result.stdout.endsWith('C4\n'));
    assert.deepEqual(result.calls.map(([name]) => name), ['c4', 'foreground', 'prompt']);
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

});

// The injection-order contract used to be the legacy assertions above
// ("memory then C4" inside one process). With the shard split, the single
// authoritative order is the registry chain
// identity→custom→references→c4-conversations→onboarding: shards run as
// independent hook processes and the flag chain — not process scheduling —
// decides what lands in context first. These tests pin that contract at the
// whole-chain level (shard-mode.test.js covers the per-link mechanics).
describe('authoritative injection order (shard chain)', () => {
  it('subsumes the legacy contract: every memory shard precedes every C4 shard in the chain', () => {
    const names = CORE_SHARDS.map(shard => shard.name);
    const lastMemory = Math.max(
      ...['identity', 'custom', 'references'].map(name => names.indexOf(name)));
    const firstC4 = Math.min(
      ...['c4-conversations'].map(name => names.indexOf(name)));
    assert.deepEqual(names, ['identity', 'custom', 'references', 'c4-conversations', 'onboarding']);
    assert.ok(lastMemory >= 0 && firstC4 > lastMemory,
      `chain ${names.join('→')} must keep memory shards ahead of C4 shards`);
  });

});
