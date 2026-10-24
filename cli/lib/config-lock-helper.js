#!/usr/bin/env node
import { updateConfigStore } from './config-store.js';

function serializeError(error) {
  const output = { message: error?.message || String(error) };
  for (const key of ['code', 'phase', 'persisted', 'stack']) {
    if (error?.[key] !== undefined) output[key] = error[key];
  }
  return output;
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const { configFile, update } = JSON.parse(input);
  const result = updateConfigStore(configFile, update);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: serializeError(error) }));
}
