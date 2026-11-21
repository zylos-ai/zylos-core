#!/usr/bin/env node
/** Keep unattended Antigravity sessions out of keyboard-only question dialogs. */
import { writeSync } from 'node:fs';
import { isMainModule } from './is-main-module.js';

const denial = reason => ({ decision: 'deny', reason });
const invalidInput = () => denial('Cannot validate tool input. Ask the user in plain text instead.');

async function loadRuntime() {
  const { loadCoreModule } = await import('./core-modules.js');
  const { getRuntime } = await loadCoreModule('runtime/index.js');
  return getRuntime('agy');
}

/** The native hook kills its shell on timeout, so this process owns its deadline. */
export function runAgyToolGuard({ input = process.stdin, complete, deadlineMs = 1000 } = {}) {
  let text = '', finished = false;
  const finish = (result, code) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    input.pause();
    complete(result, code);
  };
  const deadline = setTimeout(() => finish(invalidInput(), 1), deadlineMs);
  input.setEncoding('utf8');
  input.on('data', chunk => {
    text += chunk;
    if (Buffer.byteLength(text) > 65536) finish(invalidInput(), 1);
  });
  input.on('error', () => finish(invalidInput(), 1));
  const runtime = loadRuntime().catch(() => finish(invalidInput(), 1));
  input.on('end', async () => {
    try {
      const implementation = await runtime;
      if (!finished) finish(implementation.hooks.toolGuard(JSON.parse(text)), 0);
    }
    catch { finish(invalidInput(), 1); }
  });
}

if (isMainModule(import.meta.url)) {
  runAgyToolGuard({ complete: (result, code) => {
    try { writeSync(process.stdout.fd, JSON.stringify(result) + '\n'); }
    finally { process.exit(code); }
  } });
}
