#!/usr/bin/env node
/** Run the Antigravity hook process and orchestrate shared lifecycle work. */
// Awaits the runtime factory at module scope after installing the deadline.
// Runtime implementations must not reach this module through static imports.
import fs from 'node:fs';
import { isMainModule } from './is-main-module.js';
// Install this before loading hook modules. Native timeout kills only sh -c,
// and timed-out optional shard promises can otherwise retain this Node process.
const main = isMainModule(import.meta.url);
// Tool tracking is observational. AGY treats an empty response or a failed
// hook process as denial, so run_command must explicitly fail open.
const preToolUse = process.argv[2] === 'PreToolUse';
const failOpen = preToolUse ? '{"decision":"allow"}' : '{}';
const deadline = main ? setTimeout(() => {
  fs.writeSync(1, failOpen + '\n');
  process.stderr.write('Zylos AGY hook exceeded its process deadline.\n');
  process.exit(preToolUse ? 0 : 1);
}, process.argv[2] === 'SessionStart' ? 55000 : 5000) : null;
deadline?.unref();
function failHook() {
  // Never include native payloads or credentials in errors.
  process.stderr.write('Zylos AGY hook failed.\n');
  fs.writeSync(1, failOpen + '\n');
  clearTimeout(deadline);
  process.exit(preToolUse ? 0 : 1);
}

let handleHookActivity, collectHealthHook, wakeHealthMonitor, runSessionStartOrchestrator,
  readStdinPayload, runStep, shardHeader, buildChain, handleSessionForeground,
  publishBootstrapReady, enqueueStartupPrompt, agyRuntime;
try {
  const { loadCoreModule } = await import('./core-modules.js');
  [{ handleHookActivity }, { collectHealthHook, wakeHealthMonitor },
    { runSessionStartOrchestrator, readStdinPayload, runStep, shardHeader }, { buildChain },
    { handleSessionForeground }, { publishBootstrapReady }, { enqueueStartupPrompt }] = await Promise.all([
    import('./hook-activity.js'), import('./hook-health.js'), import('./session-start-orchestrator.js'),
    import('./shard-registry.js'), import('./session-foreground.js'), import('./bootstrap-ready.js'),
    import('./session-start-prompt.js'),
  ]);
  const { getRuntime } = await loadCoreModule('runtime/index.js');
  agyRuntime = await getRuntime('agy');
} catch (error) {
  if (!main) throw error;
  failHook();
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
  orchestrate = runAgySessionStart, instructions = agyRuntime.instructions.sessionStartInjection,
  activity = handleHookActivity, health = collectHealthHook, wake = wakeHealthMonitor } = {}) {
  const hooks = agyRuntime.hooks;
  const accepted = hooks.mainSession.accept(payload, eventName, env);
  if (!accepted) return null;
  const { event, binding } = accepted;
  if (!binding) return event === 'SessionStart' ? {} : null;
  const { rules } = hooks.mainSession.update(binding, event, payload, {
    rulesText: () => instructions({ zylosDir: env.ZYLOS_DIR }),
  });
  const reinjection = rules === null ? null : { kind: 'rules', text: rules };
  const normalized = hooks.normalize(payload, eventName);
  if (!normalized) return reinjection;
  if (normalized.hook_event_name === 'SessionStart') normalized.source = hooks.readSessionSource(env);
  await activity(normalized.hook_event_name === 'StopFailure' ? { ...normalized, hook_event_name: 'Stop' } : normalized, { env });
  const evidence = health(normalized, { env, zylosDir: env.ZYLOS_DIR });
  if (evidence) await wake({ zylosDir: env.ZYLOS_DIR });
  if (normalized.hook_event_name !== 'SessionStart') return reinjection;
  const chunks = [Buffer.from(instructions({ zylosDir: env.ZYLOS_DIR }))];
  await orchestrate(normalized, { env, stdout: { fd: 1 }, writeSync: (_fd, buffer, offset, length) => {
    chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
    return length;
  } });
  return { kind: 'session', text: Buffer.concat(chunks).toString('utf8'), source: normalized.source };
}

if (main) {
  try {
    const event = process.argv[2];
    const result = await handleAgyHook(await readStdinPayload(), { eventName: event });
    fs.writeSync(1, agyRuntime.hooks.output({ event, result }) + '\n');
    // An optional emitter may still have handles after its budget expired.
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    failHook();
  }
}
