#!/usr/bin/env node
const base = process.argv[2] || `http://127.0.0.1:${process.env.DASHBOARD_PORT || 3470}`;

async function check(path, predicate) {
  const response = await fetch(new URL(path, base));
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  const json = await response.json();
  if (predicate && !predicate(json)) throw new Error(`${path} failed payload check`);
  return json;
}

await check('/api/health', (json) => json.ok);

console.log(`dashboard API smoke ok: ${base}`);
