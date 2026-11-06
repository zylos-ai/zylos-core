#!/usr/bin/env node
import fs from 'node:fs';
import { CONTENT_PREFIX, MAX_CONTENT_BYTES, parseC4Content, validateHookInput } from '../../comm-bridge/scripts/c4-content-schema.js';
import { isMainModule } from '../../comm-bridge/scripts/is-main-module.js';

const abort = message => ({ version: 1, decision: 'abort', message });

/** Validate Dashboard output before C4 storage without performing registration. */
export function evaluateBeforeSend(input) {
  if (!validateHookInput(input) || input.hook_id !== 'dashboard.content' || input.request.channel !== 'dashboard') {
    return abort('Invalid Dashboard BeforeSend input.');
  }
  const content = input.request.content;
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return abort('Dashboard content exceeds 65536 UTF-8 bytes.');
  }
  if (content.startsWith(CONTENT_PREFIX)) {
    const parsed = parseC4Content(content);
    if (parsed.kind !== 'envelope') return abort('Invalid Dashboard structured content.');
  }
  return { version: 1, decision: 'continue' };
}

if (isMainModule(import.meta.url)) {
  let output;
  try { output = evaluateBeforeSend(JSON.parse(fs.readFileSync(0, 'utf8'))); }
  catch { output = abort('Invalid Dashboard BeforeSend input.'); }
  process.stdout.write(JSON.stringify(output) + '\n');
}
