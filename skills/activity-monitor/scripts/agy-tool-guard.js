#!/usr/bin/env node
/** Keep unattended Antigravity sessions out of keyboard-only question dialogs. */
import { readStdinPayload } from './session-start-orchestrator.js';
import { isMainModule } from './is-main-module.js';

export function guardAgyTool(payload) {
  return payload?.toolCall?.name === 'ask_question'
    ? { decision: 'deny', reason: 'Ask the user in plain text instead of calling ask_question.' }
    : { decision: 'allow' };
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(guardAgyTool(await readStdinPayload())) + '\n');
  } catch {
    process.stderr.write('Zylos Antigravity tool guard could not read its input.\n');
    process.exitCode = 1;
  }
}
