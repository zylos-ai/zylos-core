#!/usr/bin/env node
/**
 * SessionStart orchestrator.
 *
 * Runs context-producing startup steps first, then side-effect-only steps.
 * Stdout is reserved for context injection payloads.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TOTAL_BUDGET_MS = 17_000;
export const STEP_BUDGETS_MS = {
  memoryInject: 5_500,
  c4SessionInit: 5_500,
  foreground: 3_000,
  startupPrompt: 3_000,
};

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

async function logStep({ name, source, status, durationMs, stdoutBytes = 0, error }) {
  try {
    const { logHookTiming } = await import('../../comm-bridge/scripts/c4-diagnostic.js');
    const detail = [
      `session-start-orchestrator:${name}`,
      source ? `[${source}]` : '',
      `status=${status}`,
      `stdout=${stdoutBytes}`,
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
  stdout = process.stdout,
}) {
  const startMs = Date.now();
  try {
    const output = await withTimeout(Promise.resolve().then(action), budgetMs, name);
    const text = output == null ? '' : String(output);
    if (writeStdout && text.length > 0) {
      fs.writeSync(stdout.fd ?? 1, text);
    }
    await logStep({
      name,
      source,
      status: 'ok',
      durationMs: Date.now() - startMs,
      stdoutBytes: writeStdout ? Buffer.byteLength(text) : 0,
    });
    return { ok: true, output: text };
  } catch (error) {
    const timedOut = /timed out/.test(String(error?.message || error));
    console.error(`[session-start-orchestrator] step "${name}" ${timedOut ? 'timed out' : 'failed'} (${Date.now() - startMs}ms): ${error?.message || error}`);
    await logStep({
      name,
      source,
      status: timedOut ? 'timeout' : 'failed',
      durationMs: Date.now() - startMs,
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
  enqueueStartupPrompt(payload?.source || null);
}

export async function runSessionStartOrchestrator(payload = {}, {
  totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
  budgets = STEP_BUDGETS_MS,
  stdout = process.stdout,
  actions = {
    memoryInject: runMemoryInject,
    c4SessionInit: runC4SessionInit,
    foreground: runForeground,
    startupPrompt: runStartupPrompt,
  },
} = {}) {
  const source = payload?.source || null;
  const totalTimer = installProcessBackstop({ totalBudgetMs });

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
    clearTimeout(totalTimer);
  }
}

async function main() {
  installProcessBackstop();
  const payload = await readStdinPayload();
  await runSessionStartOrchestrator(payload, { totalBudgetMs: DEFAULT_TOTAL_BUDGET_MS });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[session-start-orchestrator] fatal: ${error?.stack || error?.message || error}`);
    process.exitCode = 0;
  });
}
