/**
 * Integration tests for the deduplicated early Memory Sync trigger (#626/#628).
 *
 * Claude statusLine path: spawns the REAL context-monitor.js as a child process
 * against a temp ZYLOS_DIR with stub c4-control.js / c4-db.js, and asserts the
 * full chain: trigger → enqueue recorded → persisted in-flight state suppresses
 * re-trigger across process restarts (the exact regression from #626) → state
 * clears after sync completion (checkpoint drops unsummarized count) → TTL
 * expiry re-arms the gate.
 *
 * Codex polling path: drives the real runtime-components.startContextMonitor
 * with a fake adapter, the same stub c4-control.js as a real child process, and
 * state persisted to disk — asserting the shared-gate behavior survives a
 * simulated monitor restart (fresh closure over the same state file).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_MONITOR = path.join(__dirname, '..', 'context-monitor.js');

// CHECKPOINT_THRESHOLD on main is 15 (c4-config.js single source of truth);
// use counts safely above/below it.
const COUNT_ABOVE = 45;
const COUNT_BELOW = 5;

const CONTROL_STUB = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
// Resolve the temp ZYLOS_DIR from this stub's own location:
// <tmp>/.claude/skills/comm-bridge/scripts/c4-control.js -> <tmp>
const zylosDir = path.join(__dirname, '..', '..', '..', '..');
fs.appendFileSync(path.join(zylosDir, 'c4-control-calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
`;

const DB_STUB = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const countFile = path.join(__dirname, '..', '..', '..', '..', 'unsummarized-count.txt');
let count = 0;
try { count = parseInt(fs.readFileSync(countFile, 'utf8').trim(), 10) || 0; } catch {}
process.stdout.write(JSON.stringify({ count }));
`;

let tmpDir;

function setupTempZylosDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sync-int-'));
  const scriptsDir = path.join(tmpDir, '.claude', 'skills', 'comm-bridge', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  // Stubs are CommonJS on purpose: no package.json in the temp tree, so .js
  // defaults to CJS regardless of the repo's ESM setting.
  fs.writeFileSync(path.join(scriptsDir, 'c4-control.js'), CONTROL_STUB);
  fs.writeFileSync(path.join(scriptsDir, 'c4-db.js'), DB_STUB);
  setUnsummarizedCount(COUNT_ABOVE);
}

function setUnsummarizedCount(count) {
  fs.writeFileSync(path.join(tmpDir, 'unsummarized-count.txt'), String(count));
}

function controlCalls() {
  try {
    return fs.readFileSync(path.join(tmpDir, 'c4-control-calls.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function memorySyncCalls() {
  return controlCalls().filter((args) => args.join(' ').includes('Run Memory Sync now'));
}

const STATE_FILE = () => path.join(tmpDir, 'activity-monitor', 'context-monitor-state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(mutator) {
  const state = readState() ?? {};
  fs.writeFileSync(STATE_FILE(), JSON.stringify(mutator(state), null, 2));
}

/** Run the real context-monitor.js as a fresh process — every run IS a "restart". */
function runContextMonitor({ usedPct }) {
  const status = {
    session_id: 'integration-test-session',
    context_window: { used_percentage: usedPct },
    cost: { total_cost_usd: 0.5 },
  };
  const result = spawnSync('node', [CONTEXT_MONITOR], {
    input: JSON.stringify(status),
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_DIR: tmpDir },
    timeout: 15000,
  });
  assert.equal(result.status, 0, `context-monitor exited ${result.status}: ${result.stderr}`);
  return result;
}

describe('memory sync trigger integration — Claude statusLine path', () => {
  beforeEach(setupTempZylosDir);
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('full lifecycle: trigger → restart suppression → completion clear → TTL re-arm', () => {
    // 1. First evaluation above the early threshold: exactly one sync enqueue.
    runContextMonitor({ usedPct: 60 });
    assert.equal(memorySyncCalls().length, 1, 'first run should enqueue exactly one sync');
    const call = memorySyncCalls()[0].join(' ');
    assert.match(call, /exactly one background subagent/);
    assert.match(call, /maintenance-only/);
    assert.equal(readState().memory_sync.status, 'requested');

    // 2. Fresh process (= monitor restart) while in flight: suppressed.
    //    This is the #626 regression — in-memory cooldown forgot this state.
    runContextMonitor({ usedPct: 61 });
    runContextMonitor({ usedPct: 62 });
    assert.equal(memorySyncCalls().length, 1, 'restarted process must not re-enqueue while in flight');

    // 3. Sync completes: checkpoint drops unsummarized below threshold → state clears.
    setUnsummarizedCount(COUNT_BELOW);
    runContextMonitor({ usedPct: 63 });
    assert.equal(memorySyncCalls().length, 1, 'below-threshold evaluation must not enqueue');
    assert.equal(readState().memory_sync, undefined, 'completion must clear the request state');

    // 4. New backlog + past cooldown/TTL: gate re-arms.
    setUnsummarizedCount(COUNT_ABOVE);
    runContextMonitor({ usedPct: 64 });
    assert.equal(memorySyncCalls().length, 2, 'cleared gate must allow the next trigger');
  });

  it('TTL expiry re-arms a stuck in-flight request; cooldown alone does not', () => {
    runContextMonitor({ usedPct: 60 });
    assert.equal(memorySyncCalls().length, 1);

    // Simulate a stuck sync past the 10-min cooldown but inside the 30-min TTL.
    const now = Math.floor(Date.now() / 1000);
    writeState((s) => ({
      ...s,
      memory_sync: { ...s.memory_sync, requested_at: now - 900, expires_at: now + 900 },
      last_memory_sync_trigger_at: now - 900,
    }));
    runContextMonitor({ usedPct: 61 });
    assert.equal(memorySyncCalls().length, 1, 'inside TTL: still suppressed after cooldown');

    // Push past the TTL: gate must re-arm.
    writeState((s) => ({
      ...s,
      memory_sync: { ...s.memory_sync, requested_at: now - 2000, expires_at: now - 200 },
      last_memory_sync_trigger_at: now - 2000,
    }));
    runContextMonitor({ usedPct: 62 });
    assert.equal(memorySyncCalls().length, 2, 'expired TTL must allow a fresh trigger');
  });

  it('does not trigger below the early-sync context threshold', () => {
    runContextMonitor({ usedPct: 30 });
    assert.equal(memorySyncCalls().length, 0);
  });
});

describe('memory sync trigger integration — Codex polling path', () => {
  beforeEach(setupTempZylosDir);
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  async function startCodexMonitor({ getUnsummarizedCount }) {
    const { startContextMonitor } = await import('../adapters/runtime-components.js');
    let earlyHandler;
    const fakeAdapter = {
      getContextMonitor: () => ({
        threshold: 0.7,
        startPolling: ({ onEarlyThreshold }) => { earlyHandler = onEarlyThreshold; },
      }),
    };
    const stateFile = STATE_FILE();
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    startContextMonitor(fakeAdapter, {
      getUnsummarizedCount,
      checkpointThreshold: 15,
      loadContextMonitorState: () => {
        try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
      },
      saveContextMonitorState: (state) => {
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      },
      memorySyncCooldownSeconds: 600,
      memorySyncInFlightTtlSeconds: 1800,
      c4ControlPath: path.join(tmpDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js'),
      enqueueContextRotationHandoff: () => {},
      log: () => {},
    });
    return (args) => earlyHandler(args);
  }

  it('suppresses duplicate triggers across a simulated monitor restart', async () => {
    const fire = await startCodexMonitor({ getUnsummarizedCount: () => COUNT_ABOVE });

    await fire({ used: 60, ceiling: 100, ratio: 0.6 });
    assert.equal(memorySyncCalls().length, 1, 'first poll should enqueue one sync');
    assert.equal(readState().memory_sync.status, 'requested');

    await fire({ used: 61, ceiling: 100, ratio: 0.61 });
    assert.equal(memorySyncCalls().length, 1, 'same monitor must not re-enqueue in flight');

    // Monitor restart: brand-new closure, same on-disk state.
    const fireAfterRestart = await startCodexMonitor({ getUnsummarizedCount: () => COUNT_ABOVE });
    await fireAfterRestart({ used: 62, ceiling: 100, ratio: 0.62 });
    assert.equal(memorySyncCalls().length, 1, 'restarted monitor must honor persisted in-flight state');
  });

  it('clears state and re-arms after the sync completes', async () => {
    let count = COUNT_ABOVE;
    const fire = await startCodexMonitor({ getUnsummarizedCount: () => count });

    await fire({ used: 60, ceiling: 100, ratio: 0.6 });
    assert.equal(memorySyncCalls().length, 1);

    count = COUNT_BELOW;
    await fire({ used: 61, ceiling: 100, ratio: 0.61 });
    assert.equal(readState().memory_sync, undefined, 'completion must clear the request state');

    count = COUNT_ABOVE;
    await fire({ used: 62, ceiling: 100, ratio: 0.62 });
    assert.equal(memorySyncCalls().length, 2, 'cleared gate must allow the next trigger');
  });
});
