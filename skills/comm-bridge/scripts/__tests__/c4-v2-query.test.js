import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { createQueryHandlers, runAbsorbedQuery } from '../c4-v2-cli.js';
import { escapeText, formatQueryError, formatAbsorbedPage, replyVia } from '../c4-query-format.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close()); guardDatabase(db, owner);
  const store = createStore(db, { validateComponent: () => true });
  return { db, store, query: createQueryHandlers(store) };
}
function absorb(store, from = 'single', to = 'multi') {
  const { runId } = store.beginModeTransition(from, to); store.setDrainFence('*'); store.absorbForTransition(runId); return runId;
}
const decodeE = text => text.replace(/\\(\\|n|r|t|x[0-9a-f]{2}|u[0-9a-f]{4})/g, (_, token) => ({ '\\': '\\', n: '\n', r: '\r', t: '\t' }[token] ?? String.fromCharCode(parseInt(token.slice(1), 16))));

test('E uses exact reversible control encodings and one physical line', () => {
  const original = '\\n\n\r\t\0\x1f\x7f\u0085\u2028\u2029中文';
  assert.equal(escapeText(original), '\\\\n\\n\\r\\t\\x00\\x1f\\x7f\\u0085\\u2028\\u2029中文');
  assert.equal(decodeE(escapeText(original)), original);
});
test('omitted-page metadata bounds retain 19-digit decimal widths in both encodings', () => {
  const group = 'n'.repeat(32) + ':' + 'g'.repeat(95);
  const runId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const snapshot = {
    transition: { run_id: runId, target_mode: 'multi' },
    rows: [1, 2].map(id => ({ id, session_group: group, timestamp: '2026-01-01 00:00:00', content: 'x'.repeat(65536) })),
  };
  for (const json of [false, true]) {
    const output = formatAbsorbedPage(snapshot, { group, json, maxBytes: 2048 });
    // Start with the production encoder, then widen bounded decimal metadata
    // for the analytical upper-bound fixture. This is not a 64-bit DB-id test.
    const wide = '9'.repeat(19);
    let bound;
    if (json) {
      assert.equal(JSON.parse(output).data.items[0].textOmitted, true);
      bound = output.replace(/"(id|total|after|textBytes|next)":\d+/g, (_, key) => `"${key}":${wide}`)
        .replace(/ --absorbed-reply ([a-f0-9-]+) \d+/g, ` --absorbed-reply $1 ${wide}`)
        .replace('"maxBytes":2048', '"maxBytes":16384');
    } else {
      assert.match(output, /<省略/);
      bound = output.replace(/(total=|after=|textBytes=|next=|#|--id )\d+/g, (_, prefix) => prefix + wide)
        .replace(/ --absorbed-reply ([a-f0-9-]+) \d+/g, ` --absorbed-reply $1 ${wide}`)
        .replace(/原文 \d+ B/, `原文 ${wide} B`).replace('maxBytes=2048', 'maxBytes=16384');
    }
    assert.ok(Buffer.byteLength(bound) <= (json ? 705 : 726));
    assert.ok(bound.includes(wide));
  }
});
test('absorbed pages advance across oversized first item and 1000 subsequent rows, without routes', t => {
  const { store, query } = fixture(t);
  const long = store.insertConversation('in', 'telegram', '"'.repeat(20000), 'a'.repeat(65536), { groupName: 'g-100123' });
  for (let i = 0; i < 1000; i++) store.insertConversation('in', 'telegram', 'private-route', 'x', { groupName: 'g-100123' });
  const runId = absorb(store);
  for (const json of [false, true]) {
    let after = 0; const seen = [];
    do {
      const output = query.absorbed({ runId, after, json, maxBytes: 2048 });
      assert.ok(Buffer.byteLength(output) <= 2048); assert.ok(!output.includes('private-route'));
      if (json) {
        const { data } = JSON.parse(output);
        if (after === 0) { assert.equal(data.items[0].id, long.id); assert.equal(data.items[0].textOmitted, true); assert.equal(data.items[0].text, null); }
        seen.push(...data.items.map(x => x.id)); after = data.next;
      } else {
        const ids = [...output.matchAll(/^#(\d+) \[(\d+)\]/gm)];
        ids.forEach((m, i) => assert.equal(Number(m[2]), i + 1)); seen.push(...ids.map(m => Number(m[1])));
        const footer = output.match(/count=(\d+) next=(none|\d+)\n$/); assert.equal(Number(footer[1]), ids.length);
        after = footer[2] === 'none' ? null : Number(footer[2]);
      }
    } while (after !== null);
    assert.equal(seen.length, 1001); assert.equal(new Set(seen).size, 1001);
  }
});
test('text and JSON segments reconstruct exact UTF8 and choose maximal bounded endpoints', t => {
  const { store, query } = fixture(t);
  const originals = ['\0'.repeat(8192), '\u2028'.repeat(2730), '中\n\\\u0085🚀'.repeat(2000)];
  const rows = originals.map(content => store.insertConversation('in', 'foo', content, content));
  const runId = absorb(store);
  for (const json of [false, true]) for (const field of ['text', 'endpoint']) for (const [i, row] of rows.entries()) {
    let offset = 0, combined = '', remaining;
    do {
      const output = query.absorbed({ runId, id: row.id, field, offset, json, maxBytes: 2048 });
      assert.ok(Buffer.byteLength(output) <= 2048);
      let next, data;
      if (json) ({ nextOffset: next, remaining, data } = JSON.parse(output).data);
      else {
        const header = output.match(/nextOffset=(\d+) remaining=(\d+)/); next = Number(header[1]); remaining = Number(header[2]);
        data = decodeE(output.split('\n')[1].slice(6)); assert.ok(output.endsWith(`nextOffset=${next}\n`));
      }
      assert.equal(Buffer.byteLength(data), next - offset); assert.ok(next > offset);
      assert.equal(remaining, Buffer.byteLength(originals[i]) - next);
      // Another code point would exceed the final encoded budget.
      if (remaining) {
        const rest = Buffer.from(originals[i]).subarray(next).toString('utf8'); const char = [...rest][0];
        const extra = json ? Buffer.byteLength(JSON.stringify(char)) - 2 : Buffer.byteLength(escapeText(char));
        assert.ok(Buffer.byteLength(output) + extra > 2048 - 2);
      }
      combined += data; offset = next;
    } while (remaining);
    assert.equal(combined, originals[i]);
  }
  assert.throws(() => query.absorbed({ runId, id: rows[1].id, offset: 1 }), { code: 'OFFSET_INVALID' });
});
test('missing/state-changed absorbed rows fail before any successful output', t => {
  const { db, store, query } = fixture(t);
  const row = store.insertConversation('in', 'foo', 'e', 'x'); const runId = absorb(store);
  db.prepare("UPDATE conversations SET status='failed' WHERE id=?").run(row.id);
  for (const json of [false, true]) for (const mode of [{}, { summary: true }, { id: row.id }]) {
    const result = runAbsorbedQuery(store, { runId, json, ...mode });
    assert.equal(result.exitCode, 1); assert.ok((result.stdout + result.stderr).includes('ABSORBED_MISMATCH'));
    assert.ok(!(result.stdout + result.stderr).includes('absorbed run='));
  }
  assert.equal(db.inTransaction, false);
  assert.throws(() => query.absorbed({ runId, id: row.id, after: 0 }), { code: 'INVALID_ARGS' });
  for (const maxBytes of [2047, 16385, NaN]) assert.equal(runAbsorbedQuery(store, { runId, maxBytes }).exitCode, 1);
});
test('gating is empty; summary scope order and single target aggregation follow D9', t => {
  const { store, query } = fixture(t);
  for (const groupName of ['z', 'A', 'z']) store.insertConversation('in', 'foo', 'e', 'x', { groupName });
  const { runId } = store.beginModeTransition('single', 'multi');
  assert.equal(JSON.parse(query.absorbed({ runId, json: true })).data.total, 0);
  store.setDrainFence('*'); store.absorbForTransition(runId);
  const summary = JSON.parse(query.absorbed({ runId, summary: true, json: true })).data;
  assert.deepEqual(summary.items.map(x => [x.scope, x.count]), [['foo:A', 1], ['foo:z', 2]]);
  assert.equal(JSON.parse(query.absorbed({ runId, summary: true, scopeAfter: 'foo:A', json: true })).data.count, 1);
  assert.throws(() => query.absorbed({ runId, id: 10000 }), { code: 'ABSORBED_NOT_IN_RUN' });
  store.setModeTransitionPhase(runId, 'cutover'); store.setModeTransitionPhase(runId, 'complete');
  store.insertConversation('in', 'foo', 'e', 'next', { groupName: 'z' });
  const single = absorb(store, 'multi', 'single');
  assert.deepEqual(JSON.parse(query.absorbed({ runId: single, summary: true, json: true })).data.items[0].bySourceGroup, { 'foo:z': 1 });
});
test('bounded mismatch error retains count and complete identifiers', () => {
  const ids = Array.from({ length: 10000 }, (_, i) => i + 1);
  const output = formatQueryError({ code: 'ABSORBED_MISMATCH', message: 'bad', ids }, { json: true, maxBytes: 2048 });
  assert.ok(Buffer.byteLength(output) <= 2048);
  const { error } = JSON.parse(output); assert.equal(error.count, 10000); assert.ok(error.ids.length < 10000); assert.deepEqual(error.ids, ids.slice(0, error.ids.length));
});
test('reply-via survives real POSIX shell parsing byte-for-byte', t => {
  const dir = mkdtempSync(join(tmpdir(), "c4 query ' space ")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'send.cjs'); writeFileSync(path, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  for (const endpoint of ['$(printf ROUTE_CHANGED)', '`printf ROUTE_CHANGED`', 'a"b\'c\\d', 'x; printf INJECTED', '']) {
    const command = replyVia({ id: 1, channel: 'foo', endpoint_id: endpoint, session_group: 'foo:A:b' }, path).replace('---- reply via: ', '');
    assert.deepEqual(JSON.parse(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })), ['foo', endpoint, '--session-group', 'A:b']);
  }
  for (const endpoint of ['\0', '\n', '\x7f', 'x'.repeat(131072)]) assert.match(replyVia({ id: 2, channel: 'foo', endpoint_id: endpoint }, path), /不可用/);
  assert.match(replyVia({ id: 2, channel: 'foo', endpoint_id: 'e' }, path + '\n'), /Core 路径含控制字符/);
});
test('IB50 global/group reads preserve scopes, checkpoint metadata and truncation upper bound', t => {
  const { store, query } = fixture(t);
  const a = store.insertConversation('out', 'foo', 'e', 'a');
  store.createCheckpoint('foo', a.id, 'summary');
  const b = store.insertConversation('out', 'foo', 'e', 'b');
  const c = store.insertConversation('out', 'foo', 'e', 'c');
  store.insertConversation('in', 'foo', 'e', 'pending');
  store.insertConversation('out', 'bar', 'e', 'other');
  assert.deepEqual(query.unsummarized({ group: 'foo', limit: 1 }), { rows: [b], checkpointEnd: a.id, safeEnd: c.id, upTo: b.id });
  assert.deepEqual(query.unsummarized({ group: 'foo' }).rows.map(x => x.id), [b.id, c.id]);
  assert.equal(query.unsummarizedRange().safeEnd, c.id);
  assert.throws(() => query.unsummarizedRange({ group: '*' }), { code: 'SESSION_GROUP_INVALID' });
  assert.throws(() => query.unsummarized({ group: 'foo', upToConversationId: 999 }), { code: 'UPTO_BEYOND_FRONTIER' });
  assert.equal(query.checkpoints({ group: 'foo', after: 0 })[0].summary, 'summary');
});
test('IB56 ordering uses latest head while matching/preview use latest external input', t => {
  const { store, query } = fixture(t);
  store.insertConversation('in', 'Foo', 'e1', '研发群', { groupName: 'a' });
  store.insertConversation('in', 'bar', 'e2', 'other');
  store.insertConversation('out', 'Foo', 'e1', 'outgoing');
  const groups = query.groups();
  assert.equal(groups[0].sessionGroup, 'foo:a'); assert.equal(groups[0].componentName, 'Foo'); assert.equal(groups[0].sessionGroupName, 'a');
  assert.equal(groups[0].preview.text, '研发群');
  assert.equal(query.groups({ match: '研发' }).length, 1);
  assert.equal(query.groups({ match: 'outgoing' }).length, 0);
  assert.equal(query.groups({ limit: 1 }).length, 1);
});
test('summary pagination retains every full scope in BINARY order and remains read-only', t => {
  const { db, store, query } = fixture(t);
  for (let i = 0; i < 90; i++) store.insertConversation('in', 'foo', 'e', 'x', { groupName: `g${String(i).padStart(3, '0')}${'a'.repeat(80)}` });
  const runId = absorb(store);
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  for (const json of [false, true]) {
    let scopeAfter; const scopes = [];
    do {
      const output = query.absorbed({ runId, summary: true, scopeAfter, json, maxBytes: 2048 });
      assert.ok(Buffer.byteLength(output) <= 2048);
      if (json) { const { data } = JSON.parse(output); assert.ok(data.count > 0); scopes.push(...data.items.map(x => x.scope)); scopeAfter = data.nextScope ?? undefined; }
      else { scopes.push(...[...output.matchAll(/^scope=(\S+) count=/gm)].map(m => m[1])); const next = output.match(/nextScope=(\S+)\n$/)[1]; scopeAfter = next === 'none' ? undefined : next; }
    } while (scopeAfter);
    assert.equal(scopes.length, 90); assert.equal(new Set(scopes).size, 90); assert.deepEqual(scopes, [...scopes].sort());
  }
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before); assert.equal(db.inTransaction, false);
});
test('short empty body fixture fits one page independent of 800 quoted endpoint bytes', t => {
  const { db, store, query } = fixture(t);
  const row = store.insertConversation('in', 'telegram', '"'.repeat(800), '', { groupName: 'g-100123' });
  const oldRunId = absorb(store), runId = '3b9f0c2e-5d41-4a7b-9e10-2f6a8c4d1e37';
  db.prepare('UPDATE conversations SET id=10470 WHERE id=?').run(row.id);
  db.prepare('UPDATE mode_transitions SET run_id=?, absorbed_ids=? WHERE run_id=?').run(runId, '[10470]', oldRunId);
  assert.equal(Buffer.byteLength(query.absorbed({ runId, after: 0, group: 'telegram:g-100123', json: true, maxBytes: 2048 })) <= 2048, true);
  assert.equal(Buffer.byteLength(query.absorbed({ runId, after: 0, group: 'telegram:g-100123', maxBytes: 2048 })) <= 2048, true);
});
