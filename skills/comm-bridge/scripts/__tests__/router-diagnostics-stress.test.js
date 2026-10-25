import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createJsonlStream } from '../../../../cli/lib/jsonl-stream.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'router-jsonl-stress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'router-events.jsonl') };
}
// IF10-11a: required multiprocess append and concurrent rotation workload.

function runWriter(file, id, count, signal) {
  const module = new URL('../../../../cli/lib/jsonl-stream.js', import.meta.url).href;
  const source = `import {createJsonlStream} from ${JSON.stringify(module)};
    const stream=createJsonlStream(process.argv[1]);
    for(let i=0;i<Number(process.argv[3]);i++) await stream.append({writer:process.argv[2],i,text:'x'.repeat(2048)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, file, id, String(count)], { stdio: ['ignore','pipe','pipe'], signal });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(stderr || `writer exited ${code}`)));
  });
}

test('two processes each append 10,000 long records while rotating without missing or split lines', { timeout: 600000 }, async t => {
  const { directory, file } = await fixture(t);
  const stream = createJsonlStream(file);
  let running = true;
  const rotate = (async () => {
    while (running) { await stream.maintain(); await new Promise(resolve => setTimeout(resolve, 50)); }
  })();
  try {
    const results = await Promise.allSettled([runWriter(file, 'a', 10000, t.signal), runWriter(file, 'b', 10000, t.signal)]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  finally { running = false; await rotate; }
  const rows = [];
  for (const name of await fs.readdir(directory)) {
    const text = await fs.readFile(path.join(directory, name), 'utf8');
    assert(text.endsWith('\n'));
    rows.push(...text.trimEnd().split('\n').map(JSON.parse));
  }
  assert.equal(rows.length, 20000);
  assert.equal(new Set(rows.map(row => `${row.writer}:${row.i}`)).size, 20000);
  assert(rows.every(row => row.text === 'x'.repeat(2048)));
});
