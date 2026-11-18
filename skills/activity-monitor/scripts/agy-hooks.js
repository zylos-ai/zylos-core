#!/usr/bin/env node
/** Translate AGY's native hooks into the shared, run-scoped lifecycle. */
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from './is-main-module.js';
// Install this before loading hook modules. Native timeout kills only sh -c,
// and timed-out optional shard promises can otherwise retain this Node process.
const main = isMainModule(import.meta.url);
// Tool tracking is observational. AGY treats an empty response or a failed
// hook process as denial, so run_command must explicitly fail open.
const preToolUse = process.argv[2] === 'PreToolUse';
const deadline = main ? setTimeout(() => {
  fs.writeSync(1, JSON.stringify(preToolUse ? { decision: 'allow' } : {}) + '\n');
  process.stderr.write('Zylos AGY hook exceeded its process deadline.\n');
  process.exit(preToolUse ? 0 : 1);
}, process.argv[2] === 'SessionStart' ? 55000 : 5000) : null;
deadline?.unref();
const [{ loadCoreModule }, { handleHookActivity }, { collectHealthHook, wakeHealthMonitor },
  { runSessionStartOrchestrator, readStdinPayload, runStep, shardHeader }, { buildChain },
  { handleSessionForeground }, { publishBootstrapReady }, { enqueueStartupPrompt },
  { acceptAgyMainEvent, setAgyRulesPending }] = await Promise.all([
  import('./core-modules.js'), import('./hook-activity.js'), import('./hook-health.js'),
  import('./session-start-orchestrator.js'), import('./shard-registry.js'),
  import('./session-foreground.js'), import('./bootstrap-ready.js'), import('./session-start-prompt.js'),
  import('./agy-main-session.js'),
]);
const { runDirFromEnv } = await loadCoreModule('session-group-paths.js');
const { agyInstructionContext } = await loadCoreModule('runtime/instruction-builder.js');

// Stop.error is an optional string in AGY's native hook schema. Keep only a
// category: native text can contain request URLs, keys or other private data.
function agyStopError(error) {
  if (typeof error !== 'string') return 'server_error';
  const rejectedStatus = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:\s+code)?[\s:=]*)(?:401|403)\b|\b(?:401\s+Unauthorized|403\s+Forbidden)\b/i;
  const rejectedKey = /\bAPI_KEY_INVALID\b|\b(?:invalid|rejected)\s+API[ _-]?key\b|\bAPI[ _-]?key\s+(?:(?:is|was)\s+)?(?:not valid|invalid|rejected)\b/i;
  if (rejectedStatus.test(error) || rejectedKey.test(error)) return 'authentication_failed';
  return /proxyconnect|connection\s+refused|\b(?:ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/i.test(error) ? 'network_error' : 'server_error';
}

export function normalizeAgyHook(payload, eventName) {
  if (!payload || typeof payload !== 'object') return null;
  const event = eventName || payload.hookEventName || payload.hook_event_name;
  const session = payload.conversationId;
  if (!['SessionStart', 'PreInvocation', 'Stop', 'PreToolUse', 'PostToolUse'].includes(event) || typeof session !== 'string' || !session) return null;
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    if (payload.toolCall?.name !== 'run_command' || typeof payload.toolCall.id !== 'string' || !payload.toolCall.id) return null;
    return { session_id: session, transcript_path: payload.transcriptPath,
      hook_event_name: event === 'PostToolUse' && payload.error ? 'PostToolUseFailure' : event,
      tool_name: 'run_command', tool_use_id: payload.toolCall.id, tool_input: payload.toolCall.args,
      ...(event === 'PostToolUse' && payload.error ? { error: 'tool_error' } : {}) };
  }
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
  const event = eventName || payload?.hookEventName || payload?.hook_event_name;
  if (!['SessionStart', 'PreInvocation', 'Stop', 'PreToolUse', 'PostToolUse'].includes(event)) return null;
  const binding = acceptAgyMainEvent(payload, event, env);
  if (!binding) return event === 'SessionStart' ? {} : null;
  if (event === 'Stop' && String(payload.terminationReason).toUpperCase() === 'TERMINAL_CUSTOM_HOOK') setAgyRulesPending(binding, true);
  let reinjection = null;
  if (event === 'PreInvocation' && binding.record.rulesPending) {
    reinjection = { injectSteps: [{ systemMessage: { systemMessage: instructions({ zylosDir: env.ZYLOS_DIR }) } }] };
    setAgyRulesPending(binding, false);
  }
  const normalized = normalizeAgyHook(payload, eventName);
  if (!normalized) return reinjection;
  if (normalized.hook_event_name === 'SessionStart') normalized.source = readAgySessionSource(env);
  activity(normalized.hook_event_name === 'StopFailure' ? { ...normalized, hook_event_name: 'Stop' } : normalized, { env });
  const evidence = health(normalized, { env, zylosDir: env.ZYLOS_DIR });
  if (evidence) await wake({ zylosDir: env.ZYLOS_DIR });
  if (normalized.hook_event_name !== 'SessionStart') return reinjection;
  const chunks = [Buffer.from(instructions({ zylosDir: env.ZYLOS_DIR }))];
  await orchestrate(normalized, { env, stdout: { fd: 1 }, writeSync: (_fd, buffer, offset, length) => {
    chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
    return length;
  } });
  return { injectSteps: [{ systemMessage: { systemMessage: Buffer.concat(chunks).toString('utf8') } }] };
}

if (main) {
  try {
    const result = await handleAgyHook(await readStdinPayload(), { eventName: process.argv[2] });
    fs.writeSync(1, JSON.stringify(preToolUse ? { decision: 'allow' } : result || {}) + '\n');
    // An optional emitter may still have handles after its budget expired.
    // The hook process owns this deadline and exits explicitly after output.
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    // Hook output is a protocol: never include native payloads or credentials in errors.
    process.stderr.write('Zylos AGY hook failed.\n');
    fs.writeSync(1, JSON.stringify(preToolUse ? { decision: 'allow' } : {}) + '\n');
    clearTimeout(deadline);
    process.exit(preToolUse ? 0 : 1);
  }
}
