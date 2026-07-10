#!/usr/bin/env node
/**
 * SessionStart orchestrator.
 *
 * Two modes:
 * - `--shard <name>`: emit a single injection shard (or run a single
 *   side-effect step). Hook sync installs one command per shard so each
 *   shard gets its own hook stdout budget; the shard sequencer pins the
 *   injection order to chain order (see shard-sequencer.js).
 * - no arguments (legacy): run every startup step in-process with a single
 *   combined stdout. Kept for installs whose settings.json still points at
 *   the un-sharded command.
 *
 * Stdout is reserved for context injection payloads in both modes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSection } from '../../comm-bridge/scripts/session-format.js';
import {
  SIDE_EFFECT_NAMES,
  estimateTokens,
  fitToBudget,
  resolveShard,
  withinBudget,
} from './shard-registry.js';
import {
  ladderDeadlineMs,
  perUserSuffix,
  sweepStaleFlags,
  tLinkMs,
  waitForFlag,
  writeFlag,
} from './shard-sequencer.js';

export const DEFAULT_TOTAL_BUDGET_MS = 17_000;
export const STEP_BUDGETS_MS = {
  memoryInject: 5_500,
  c4SessionInit: 5_500,
  foreground: 3_000,
  startupPrompt: 3_000,
};
export const SHARD_EMIT_BUDGET_MS = 5_500;
// Per-user root for the same reason as the flag root (see perUserSuffix in
// shard-sequencer.js): a fixed name under shared /tmp is unwritable for the
// second zylos user on a multi-user host.
const SPILL_ROOT_NAME = `zylos-shard-spill-${perUserSuffix()}`;

export function installProcessBackstop({
  totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  exit = process.exit,
} = {}) {
  const timer = setTimeout(() => {
    console.error(`[session-start-orchestrator] total budget ${totalBudgetMs}ms exceeded; exiting`);
    exit(0);
  }, totalBudgetMs);
  timer.unref?.();
  return timer;
}

export function writeAllSync(fd, text, {
  writeSync = fs.writeSync,
} = {}) {
  const buffer = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
  let offset = 0;
  while (offset < buffer.length) {
    try {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error(`writeSync made no progress at offset ${offset}`);
      }
      offset += written;
    } catch (error) {
      if (error?.code === 'EAGAIN') continue;
      throw error;
    }
  }
  return offset;
}

export function readStdinPayload({
  stdin = process.stdin,
  timeoutMs = 500,
} = {}) {
  return new Promise((resolve) => {
    let input = '';
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off?.('data', onData);
      stdin.off?.('end', onEnd);
      stdin.pause?.();
      stdin.unref?.();
      resolve(payload);
    };
    const onData = chunk => { input += chunk; };
    const onEnd = () => {
      try {
        finish(JSON.parse(input || '{}'));
      } catch {
        finish({});
      }
    };
    const timer = setTimeout(() => finish({}), timeoutMs);
    timer.unref?.();
    stdin.setEncoding?.('utf8');
    stdin.on?.('data', onData);
    stdin.on?.('end', onEnd);
  });
}

async function logStep({ name, source, status, durationMs, stdoutBytes = 0, extra, error }) {
  try {
    const { logHookTiming } = await import('../../comm-bridge/scripts/c4-diagnostic.js');
    const detail = [
      `session-start-orchestrator:${name}`,
      source ? `[${source}]` : '',
      `status=${status}`,
      `stdout=${stdoutBytes}`,
      extra || '',
      error ? `error=${String(error.message || error).replace(/\s+/g, '_').slice(0, 120)}` : '',
    ].filter(Boolean).join(':');
    logHookTiming(detail, durationMs);
  } catch {
    // Diagnostics are best-effort.
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runStep({
  name,
  source,
  budgetMs,
  action,
  writeStdout = false,
  extra,
  stdout = process.stdout,
  writeSync = fs.writeSync,
}) {
  const startMs = Date.now();
  try {
    const output = await withTimeout(Promise.resolve().then(action), budgetMs, name);
    const text = output == null ? '' : String(output);
    if (writeStdout && text.length > 0) {
      writeAllSync(stdout.fd ?? 1, text, { writeSync });
    }
    await logStep({
      name,
      source,
      status: 'ok',
      durationMs: Date.now() - startMs,
      stdoutBytes: writeStdout ? Buffer.byteLength(text) : 0,
      extra,
    });
    return { ok: true, output: text };
  } catch (error) {
    const timedOut = /timed out/.test(String(error?.message || error));
    console.error(`[session-start-orchestrator] step "${name}" ${timedOut ? 'timed out' : 'failed'} (${Date.now() - startMs}ms): ${error?.message || error}`);
    // For context-producing steps, make the failure visible in the injected
    // stream instead of silently dropping the section — otherwise a failed
    // step reads as "this context simply doesn't exist".
    if (writeStdout) {
      const notice = formatSection(
        `${name.toUpperCase()} UNAVAILABLE`,
        `session-start step "${name}" ${timedOut ? 'timed out' : 'failed'}: ${error?.message || error}`,
      );
      writeAllSync(stdout.fd ?? 1, `${notice}\n`, { writeSync });
    }
    await logStep({
      name,
      source,
      status: timedOut ? 'timeout' : 'failed',
      durationMs: Date.now() - startMs,
      extra,
      error,
    });
    return { ok: false, error };
  }
}

async function runMemoryInject(payload) {
  const { injectMemory } = await import('../../zylos-memory/scripts/session-start-inject.js');
  return injectMemory(payload);
}

async function runC4SessionInit(payload) {
  const { initC4Session } = await import('../../comm-bridge/scripts/c4-session-init.js');
  return initC4Session(payload);
}

async function runForeground(payload) {
  const { handleSessionForeground } = await import('./session-foreground.js');
  handleSessionForeground(payload);
}

async function runStartupPrompt(payload) {
  const { enqueueStartupPrompt } = await import('./session-start-prompt.js');
  return enqueueStartupPrompt(payload?.source || null);
}

export async function runSessionStartOrchestrator(payload = {}, {
  totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  budgets = STEP_BUDGETS_MS,
  stdout = process.stdout,
  hardBackstopTimer = null,
  actions = {
    memoryInject: runMemoryInject,
    c4SessionInit: runC4SessionInit,
    foreground: runForeground,
    startupPrompt: runStartupPrompt,
  },
} = {}) {
  const source = payload?.source || null;
  const totalTimer = hardBackstopTimer || installProcessBackstop({ totalBudgetMs });

  try {
    await runStep({
      name: 'memory-inject',
      source,
      budgetMs: budgets.memoryInject,
      action: () => actions.memoryInject(payload),
      writeStdout: true,
      stdout,
    });

    await runStep({
      name: 'c4-session-init',
      source,
      budgetMs: budgets.c4SessionInit,
      action: () => actions.c4SessionInit(payload),
      writeStdout: true,
      stdout,
    });

    const sideEffects = [
      runStep({
        name: 'session-foreground',
        source,
        budgetMs: budgets.foreground,
        action: () => actions.foreground(payload),
      }),
    ];

    if (source === 'compact') {
      await logStep({
        name: 'session-start-prompt',
        source,
        status: 'skipped',
        durationMs: 0,
      });
    } else {
      sideEffects.push(runStep({
        name: 'session-start-prompt',
        source,
        budgetMs: budgets.startupPrompt,
        action: () => actions.startupPrompt(payload),
      }));
    }

    await Promise.all(sideEffects);
  } finally {
    if (!hardBackstopTimer) clearTimeout(totalTimer);
  }
}

/**
 * Numbered self-describing shard header. This is the fail-safe half of the
 * ordering design: a crashed shard leaves no trace in context at all (only a
 * transcript-level hook error), so a missing [k/N] number is the ONLY
 * in-context signal that a shard was lost. The header sits within the first
 * 2KB, so it survives the persisted-output preview if a budget is ever blown.
 */
export function shardHeader({ position, total, name, waitNote = '' }) {
  return `=== ZYLOS STARTUP CONTEXT [${position}/${total}] ${name}${waitNote ? ` (${waitNote})` : ''} ===`;
}

export function shardSpillPath(sessionId, shardName, { tmpdir = os.tmpdir() } = {}) {
  const cleaned = String(sessionId || 'nosession').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return path.join(tmpdir, SPILL_ROOT_NAME, cleaned, `${shardName}.txt`);
}

/**
 * Compose a shard's stdout under its dual budget (chars for Claude's 10K
 * persist threshold, estimated tokens for Codex's elision threshold). Over
 * budget → keep the header, trim the body tail, and point at the spilled
 * full copy so nothing is lost.
 */
export function composeShardOutput({ header, body, budget, spillPath }) {
  const trimmedBody = (body == null ? '' : String(body)).trim();
  const full = trimmedBody ? `${header}\n${trimmedBody}\n` : `${header}\n`;
  if (withinBudget(full, budget)) {
    return { output: full, truncated: false };
  }

  const notice = keptChars =>
    `\n[shard output truncated: first ${keptChars} of ${trimmedBody.length} chars inline; full section saved to: ${spillPath}]`;
  const worstOverhead = `${header}${notice(trimmedBody.length)}\n`;
  const fit = fitToBudget(trimmedBody, {
    maxChars: Math.max(0, budget.maxChars - (worstOverhead.length + 1)),
    maxTokens: Math.max(0, budget.maxTokens - estimateTokens(worstOverhead)),
  });
  return {
    output: `${header}\n${fit.text}${notice(fit.text.length)}\n`,
    truncated: true,
    fullBody: trimmedBody,
  };
}

async function runShardSideEffect(name, payload, {
  source,
  budgets,
  actions,
  chain,
  sessionId,
  linkMs,
  waitForFlagImpl,
  sequencerOptions = {},
}) {
  if (name === SIDE_EFFECT_NAMES.foreground) {
    await runStep({
      name: 'session-foreground',
      source,
      budgetMs: budgets.foreground,
      action: () => actions.foreground(payload),
    });
    return;
  }

  // start-prompt: the startup prompt must be enqueued only after the
  // injection chain has finished, or the agent starts acting with no memory
  // in context. Wait on the last in-chain shard's flag; fail open past the
  // chain-tail deadline so the prompt is never permanently withheld.
  if (source === 'compact') {
    await logStep({ name: 'session-start-prompt', source, status: 'skipped', durationMs: 0 });
    return;
  }

  let waitExtra = '';
  const tail = chain.at(-1);
  if (tail && sessionId) {
    const wait = await waitForFlagImpl(sessionId, tail.name, {
      deadlineMs: ladderDeadlineMs(chain.length, linkMs),
      ...sequencerOptions,
    });
    waitExtra = `wait=${wait.ok ? 'ok' : 'timeout'}:${wait.waitedMs}`;
  }
  await runStep({
    name: 'session-start-prompt',
    source,
    budgetMs: budgets.startupPrompt,
    extra: waitExtra,
    action: () => actions.startupPrompt(payload),
  });
}

/**
 * `--shard <name>` entry point: emit one content shard (predecessor wait →
 * emit → budgeted stdout → completion flag) or run one side-effect step.
 * Every failure path is fail-open — a shard-mode process must never block
 * session start or exit non-zero.
 */
export async function runSessionStartShard(name, payload = {}, {
  budgets = STEP_BUDGETS_MS,
  emitBudgetMs = SHARD_EMIT_BUDGET_MS,
  stdout = process.stdout,
  zylosDir,
  tmpdir,
  linkMs = tLinkMs(),
  resolveShardImpl = resolveShard,
  waitForFlagImpl = waitForFlag,
  writeFlagImpl = writeFlag,
  actions = {
    foreground: runForeground,
    startupPrompt: runStartupPrompt,
  },
} = {}) {
  const source = payload?.source || null;
  const sessionId = typeof payload?.session_id === 'string' && payload.session_id ? payload.session_id : null;
  const sequencerOptions = tmpdir ? { tmpdir } : {};

  try {
    sweepStaleFlags(sequencerOptions);
  } catch { /* best-effort janitor */ }

  const resolved = resolveShardImpl(name, zylosDir ? { zylosDir } : {});
  if (!resolved) {
    console.error(`[session-start-orchestrator] unknown shard "${name}"; emitting nothing (fail-open)`);
    await logStep({ name: `shard-${name}`, source, status: 'unknown-shard', durationMs: 0 });
    return;
  }
  for (const warning of resolved.warnings || []) {
    console.error(`[session-start-orchestrator] shard declaration warning: ${warning}`);
  }

  if (resolved.kind === 'side-effect') {
    await runShardSideEffect(name, payload, {
      source,
      budgets,
      actions,
      chain: resolved.chain,
      sessionId,
      linkMs,
      waitForFlagImpl,
      sequencerOptions,
    });
    return;
  }

  const { shard, chain } = resolved;
  const startMs = Date.now();

  // Serialize: wait for the predecessor's flag with this shard's ladder
  // deadline. No session id means no isolation key, so skip serialization
  // entirely rather than risk cross-session flag poisoning.
  let waitNote = '';
  let waitExtra = 'wait=none';
  const predecessor = shard.chainIndex > 0 ? chain[shard.chainIndex - 1] : null;
  if (predecessor && sessionId) {
    const wait = await waitForFlagImpl(sessionId, predecessor.name, {
      deadlineMs: ladderDeadlineMs(shard.chainIndex, linkMs),
      ...sequencerOptions,
    });
    waitExtra = `wait=${wait.ok ? 'ok' : 'timeout'}:${wait.waitedMs}`;
    if (!wait.ok) waitNote = `predecessor "${predecessor.name}" not ready after ${wait.waitedMs}ms, continued`;
  } else if (!sessionId) {
    console.error(`[session-start-orchestrator] shard "${name}": no session_id in hook payload; emitting without serialization`);
  }

  let body = '';
  let status = 'ok';
  let error = null;
  try {
    const output = await withTimeout(Promise.resolve().then(() => shard.emit(payload)), emitBudgetMs, name);
    body = output == null ? '' : String(output);
  } catch (err) {
    // Keep the failure visible in the injected stream (and keep the [k/N]
    // numbering intact) instead of silently dropping the section.
    error = err;
    status = /timed out/.test(String(err?.message || err)) ? 'timeout' : 'failed';
    body = formatSection(
      `${name.toUpperCase()} UNAVAILABLE`,
      `session-start shard "${name}" ${status === 'timeout' ? 'timed out' : 'failed'}: ${err?.message || err}`,
    );
  }

  const header = shardHeader({
    position: shard.chainIndex + 1,
    total: chain.length,
    name: shard.name,
    waitNote,
  });
  const spillPath = shardSpillPath(sessionId, shard.name, sequencerOptions);
  const composed = composeShardOutput({ header, body, budget: shard.budget, spillPath });
  if (composed.truncated) {
    try {
      fs.mkdirSync(path.dirname(spillPath), { recursive: true });
      fs.writeFileSync(spillPath, composed.fullBody);
    } catch (spillError) {
      console.error(`[session-start-orchestrator] shard "${name}": failed to spill full output: ${spillError.message}`);
    }
  }

  writeAllSync(stdout.fd ?? 1, composed.output);

  // Flag goes down only after our bytes are out — it is the "injected"
  // signal successors serialize on. An emitter failure still flags: the
  // failure notice was emitted in this shard's slot, so successors must not
  // burn their ladder deadline waiting for a shard that already spoke.
  if (sessionId) {
    writeFlagImpl(sessionId, shard.name, sequencerOptions);
  }

  await logStep({
    name: `shard-${shard.name}`,
    source,
    status,
    durationMs: Date.now() - startMs,
    stdoutBytes: Buffer.byteLength(composed.output),
    extra: [waitExtra, composed.truncated ? 'truncated=1' : ''].filter(Boolean).join(':'),
    error,
  });
}

export function parseShardArg(argv) {
  const index = argv.indexOf('--shard');
  if (index === -1) return null;
  return argv[index + 1] || null;
}

async function main() {
  const hardBackstopTimer = installProcessBackstop();
  const shardName = parseShardArg(process.argv.slice(2));
  const payload = await readStdinPayload();
  try {
    if (shardName) {
      await runSessionStartShard(shardName, payload);
    } else {
      await runSessionStartOrchestrator(payload, {
        totalBudgetMs: DEFAULT_TOTAL_BUDGET_MS,
        hardBackstopTimer,
      });
    }
  } finally {
    clearTimeout(hardBackstopTimer);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[session-start-orchestrator] fatal: ${error?.stack || error?.message || error}`);
    process.exitCode = 0;
  });
}
