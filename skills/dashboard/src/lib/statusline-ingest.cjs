#!/usr/bin/env node
// StatusLine ingest script — configured as settings.json statusLine command.
// Reads StatusLine JSON from stdin and prints a compact status display.
// Must use only Node built-ins. Must complete within 500ms.
'use strict';

setTimeout(() => process.exit(0), 500);

async function main() {
  const stdin = await readStdin();
  if (!stdin) { outputStatus(null); process.exit(0); }

  let data;
  try { data = JSON.parse(stdin); } catch { outputStatus(null); process.exit(0); }

  outputStatus(data);

  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let timer = setTimeout(() => resolve(chunks.join('')), 200);
    process.stdin.on('data', (c) => {
      clearTimeout(timer);
      chunks.push(c.toString());
      timer = setTimeout(() => resolve(chunks.join('')), 50);
    });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(chunks.join('')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

function outputStatus(data) {
  if (!data) { process.stdout.write('--\n'); return; }
  const parts = [];
  const model = data.model?.display_name || data.model?.id || '';
  if (model) parts.push(model);
  const ctx = data.context_window?.used_percentage;
  if (ctx != null) parts.push(`${Math.round(ctx)}%`);
  const cost = data.cost?.total_cost_usd;
  if (cost != null) parts.push(`$${Number(cost).toFixed(4)}`);
  process.stdout.write((parts.join(' | ') || '--') + '\n');
}

try { main(); } catch { process.exit(0); }
