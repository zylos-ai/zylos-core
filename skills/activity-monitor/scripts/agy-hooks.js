#!/usr/bin/env node
/** Translate AGY's native hooks into the shared, run-scoped lifecycle. */
import fs from 'node:fs';
import path from 'node:path';
import { loadCoreModule } from './core-modules.js';
import { handleHookActivity } from './hook-activity.js';
import { collectHealthHook, wakeHealthMonitor } from './hook-health.js';
import { runSessionStartOrchestrator, readStdinPayload, runStep, shardHeader } from './session-start-orchestrator.js';
import { buildChain } from './shard-registry.js';
import { handleSessionForeground } from './session-foreground.js';
import { publishBootstrapReady } from './bootstrap-ready.js';
import { enqueueStartupPrompt } from './session-start-prompt.js';
import { isMainModule } from './is-main-module.js';
const { runDirFromEnv } = await loadCoreModule('session-group-paths.js');
const { agyInstructionContext } = await loadCoreModule('runtime/instruction-builder.js');

// Stop.error is an optional string in AGY's native hook schema. Keep only a
// category: native text can contain request URLs, keys or other private data.
function agyStopError(error) {
  if (typeof error !== 'string') return 'server_error';
  const rejectedStatus = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:\s+code)?[\s:=]*)(?:401|403)\b|\b(?:401\s+Unauthorized|403\s+Forbidden)\b/i;
  const rejectedKey = /\bAPI_KEY_INVALID\b|\b(?:invalid|rejected)\s+API[ _-]?key\b|\bAPI[ _-]?key\s+(?:(?:is|was)\s+)?(?:not valid|invalid|rejected)\b/i;
  return rejectedStatus.test(error) || rejectedKey.test(error) ? 'authentication_failed' : 'server_error';
}

export function normalizeAgyHook(payload, eventName) {
  if (!payload || typeof payload !== 'object') return null;
  const event = eventName || payload.hookEventName || payload.hook_event_name;
  const session = payload.conversationId;
  if (!['SessionStart', 'PreInvocation', 'Stop'].includes(event) || typeof session !== 'string' || !session) return null;
  if (event === 'PreInvocation' && payload.invocationNum !== 0) return null;
  if (event === 'Stop' && payload.fullyIdle !== true && String(payload.terminationReason).toUpperCase() !== 'ERROR') return null;
  return { ...payload, session_id: session, transcript_path: payload.transcriptPath,
    hook_event_name: event === 'PreInvocation' ? 'UserPromptSubmit' :
      event === 'Stop' && String(payload.terminationReason).toUpperCase() === 'ERROR' ? 'StopFailure' : event,
    ...(event === 'Stop' && String(payload.terminationReason).toUpperCase() === 'ERROR' ? { error: agyStopError(payload.error) } : {}) };
}

export function readAgySessionSource(env = process.env) {
  const file = path.join(runDirFromEnv(env).dir, 'agy-session-source');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    const marker = JSON.parse(raw);
    const source = marker.runId === env.ZYLOS_RUN_ID && marker.source === 'clear' ? 'clear' : 'startup';
    return source;
  }
  catch { return 'startup'; }
}

export async function runAgySessionStart(payload, { env = process.env, chainBuilder = buildChain,
  foreground = handleSessionForeground, ready = publishBootstrapReady, enqueue = enqueueStartupPrompt, ...output } = {}) {
  return runSessionStartOrchestrator(payload, {
    ...output,
    totalBudgetMs: 55000,
    budgets: { memoryInject: 45000, c4SessionInit: 1000, foreground: 3000, startupPrompt: 3000 },
    actions: {
      memoryInject: async () => {
        const { chain } = chainBuilder({ zylosDir: env.ZYLOS_DIR });
        for (const shard of chain) await runStep({
          name: `shard-${shard.name}`, source: payload.source, budgetMs: 5500,
          action: async () => `${shardHeader({position:shard.chainIndex+1,total:chain.length,name:shard.name})}\n${await shard.emit(payload)}\n`,
          writeStdout: true, ...output,
        });
        return '';
      },
      c4SessionInit: () => '',
      foreground: () => foreground(payload),
      startupPrompt: () => env.ZYLOS_RUN_ID ? ready(payload) : enqueue(payload.source),
    },
  });
}

export async function handleAgyHook(payload, { eventName, env = process.env,
  orchestrate = runAgySessionStart, instructions = agyInstructionContext,
  activity = handleHookActivity, health = collectHealthHook, wake = wakeHealthMonitor } = {}) {
  const normalized = normalizeAgyHook(payload, eventName);
  if (!normalized) return null;
  if (normalized.hook_event_name === 'SessionStart') normalized.source = readAgySessionSource(env);
  activity(normalized.hook_event_name === 'StopFailure' ? { ...normalized, hook_event_name: 'Stop' } : normalized, { env });
  const evidence = health(normalized, { env, zylosDir: env.ZYLOS_DIR });
  if (evidence) await wake({ zylosDir: env.ZYLOS_DIR });
  if (normalized.hook_event_name !== 'SessionStart') return null;
  const chunks = [Buffer.from(instructions({ zylosDir: env.ZYLOS_DIR }))];
  await orchestrate(normalized, { env, stdout: { fd: 1 }, writeSync: (_fd, buffer, offset, length) => {
    chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
    return length;
  } });
  return { injectSteps: [{ systemMessage: { systemMessage: Buffer.concat(chunks).toString('utf8') } }] };
}

if (isMainModule(import.meta.url)) {
  try {
    const result = await handleAgyHook(await readStdinPayload(), { eventName: process.argv[2] });
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // Hook output is a protocol: never include native payloads or credentials in errors.
    process.stderr.write('Zylos AGY hook failed.\n');
    process.exitCode = 1;
  }
}
