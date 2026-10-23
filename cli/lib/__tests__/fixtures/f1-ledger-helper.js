#!/usr/bin/env node
import fs from 'node:fs';
import { updateConfigStore } from '../../config-store.js';

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
  const ledgerFile = process.env.F1_COMMIT_LEDGER;
  if (!ledgerFile) throw new Error('F1_COMMIT_LEDGER is required');
  const result = updateConfigStore(configFile, update, {
    faultInjector(stage, context) {
      if (stage !== 'after_rename') return;
      let sequence = 1;
      try {
        sequence = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean).length + 1;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      fs.appendFileSync(ledgerFile, `${JSON.stringify({
        sequence,
        value: context.result.config.shared,
        previous: context.result.previous.shared,
      })}\n`);
    },
  });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: serializeError(error) }));
}
