import { seedHistoricalAbsorption } from './fixtures/historical-absorption.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture as storeFixture } from './c4-v2-test-helpers.js';
import { createQueryHandlers } from '../c4-v2-cli.js';
import { escapeText, replyVia } from '../c4-query-format.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function fixture(t) {
  const { db, store } = storeFixture(t);
  return { db, store, query: createQueryHandlers(store) };
}
function absorb(db, store) {
  const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*'); seedHistoricalAbsorption(db, runId); return runId;
}
// Historical reverse conversions remain readable; current writers only migrate forward.
const decodeE = text => text.replace(/\\(\\|n|r|t|x[0-9a-f]{2}|u[0-9a-f]{4})/g, (_, token) => ({ '\\': '\\', n: '\n', r: '\r', t: '\t' }[token] ?? String.fromCharCode(parseInt(token.slice(1), 16))));

test('full text and JSON return complete UTF8 fields with end marker in text mode', t => {
  const { db, store, query } = fixture(t);
  const originals = ['\0'.repeat(8192), '\u2028'.repeat(2730), '中\n\\\u0085🚀'.repeat(2000), ''];
  const rows = originals.map(content => store.insertConversation('in', 'foo', content || null, content));
  const runId = absorb(db, store);
  for (const [i, row] of rows.entries()) for (const field of ['text', 'endpoint']) {
    const output = query.absorbed({ runId, id: row.id, field });
    assert.equal(output, `absorbed-full run=${runId} id=${row.id} field=${field} bytes=${Buffer.byteLength(originals[i])}\ndata: ${escapeText(originals[i])}\nend id=${row.id} field=${field}\n`);
    const lines = output.trimEnd().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(decodeE(lines[1].slice(6)), originals[i]);
    assert.deepEqual(JSON.parse(query.absorbed({ runId, id: row.id, field, json: true })),
      { ok: true, data: { runId, id: row.id, field, bytes: Buffer.byteLength(originals[i]), data: originals[i] } });
  }
});
test('reply-via survives real POSIX shell parsing byte-for-byte', t => {
  const dir = mkdtempSync(join(tmpdir(), "c4 query ' space ")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'send.cjs'); writeFileSync(path, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  for (const endpoint of ['$(printf ROUTE_CHANGED)', '`printf ROUTE_CHANGED`', 'a"b\'c\\d', 'x; printf INJECTED', '']) {
    const command = replyVia({ id: 1, channel: 'foo', endpoint_id: endpoint, session_group: 'foo:A:b' }, path).replace('---- reply via: ', '');
    assert.deepEqual(JSON.parse(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })), ['foo', endpoint]);
  }
  for (const endpoint of ['\0', '\n', '\x7f', 'x'.repeat(131072)]) assert.match(replyVia({ id: 2, channel: 'foo', endpoint_id: endpoint }, path), /unavailable/);
  assert.match(replyVia({ id: 2, channel: 'foo', endpoint_id: 'e' }, path + '\n'), /Core path contains control characters/);
});
