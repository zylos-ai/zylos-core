import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { createQueryHandlers, runAbsorbedQuery } from '../c4-v2-cli.js';
import { escapeText, formatQueryError, formatAbsorbedPage, replyVia } from '../c4-query-format.js';
import { execFileSync } from 'node:child_process';
import fs, { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
test('absorbed pages default to 20 rows and advance by count across 1001 rows without routes', t => {
  const { db, store, query } = fixture(t);
  const long = store.insertConversation('in', 'telegram', '"'.repeat(20000), 'a'.repeat(65536), { groupName: 'g-100123' });
  for (let i = 0; i < 1000; i++) store.insertConversation('in', 'telegram', 'private-route', 'x', { groupName: 'g-100123' });
  const runId = absorb(store), before = db.prepare('SELECT total_changes() AS n').get().n;
  for (const json of [false, true]) {
    let after = 0; const seen = [];
    do {
      const output = query.absorbed({ runId, after, json });
      assert.ok(!output.includes('private-route'));
      if (json) {
        const { data } = JSON.parse(output);
        assert.equal(data.limit, 20); assert.ok(data.count <= 20);
        if (after === 0) {
          assert.equal(data.count, 20);
          assert.equal(data.items[0].id, long.id);
          assert.equal(data.items[0].textTruncated, true);
          assert.equal(data.items[0].text, 'a'.repeat(300));
          assert.equal(data.items[0].textBytes, 65536);
        }
        seen.push(...data.items.map(x => x.id)); after = data.next;
      } else {
        assert.match(output, /after=\d+ limit=20\n/);
        const ids = [...output.matchAll(/^#(\d+) \[(\d+)\]/gm)];
        ids.forEach((m, i) => assert.equal(Number(m[2]), i + 1)); seen.push(...ids.map(m => Number(m[1])));
        const footer = output.match(/count=(\d+) next=(none|\d+)\n$/);
        assert.equal(Number(footer[1]), ids.length); assert.ok(ids.length <= 20);
        if (after === 0) assert.match(output, / …<截断：原文 65536 B；全文 --id 1>/);
        after = footer[2] === 'none' ? null : Number(footer[2]);
      }
    } while (after !== null);
    assert.equal(seen.length, 1001); assert.equal(new Set(seen).size, 1001);
  }
  const maximum = JSON.parse(query.absorbed({ runId, limit: 100, json: true })).data;
  assert.equal(maximum.count, 100); assert.equal(maximum.next, 100);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(db.inTransaction, false);
});
test('preview takes 300 Unicode code points, preserves complete characters and marks truncation', t => {
  const { store, query } = fixture(t);
  const originals = ['中'.repeat(299) + '🚀尾', '🚀'.repeat(300), '\0'.repeat(8192), '\u2028'.repeat(2730), '短\n\\\r\t正文'];
  const rows = originals.map(content => store.insertConversation('in', 'foo', 'private-route', content));
  const runId = absorb(store);
  const json = JSON.parse(query.absorbed({ runId, json: true })).data;
  for (const [index, item] of json.items.entries()) {
    const codepoints = Array.from(originals[index]);
    assert.equal(item.id, rows[index].id);
    assert.equal(item.text, codepoints.slice(0, 300).join(''));
    assert.equal(Array.from(item.text).length, Math.min(300, codepoints.length));
    assert.equal(item.textTruncated, codepoints.length > 300);
    assert.equal(item.textBytes, Buffer.byteLength(originals[index]));
  }
  assert.equal(json.items[0].text.endsWith('🚀'), true);
  assert.equal(json.items[1].textTruncated, false);
  const output = query.absorbed({ runId });
  const previewLines = output.split('\n').filter(line => line.startsWith('text: '));
  assert.equal(previewLines.length, originals.length);
  previewLines.forEach((line, i) => {
    const item = json.items[i];
    const annotation = item.textTruncated ? ` …<截断：原文 ${item.textBytes} B；全文 --id ${item.id}>` : '';
    assert.equal(line, 'text: ' + escapeText(item.text) + annotation);
  });
});
test('page size follows limit even when encoded previews exceed the former byte budget', () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, session_group: 'foo', timestamp: '2026-01-01 00:00:00', content: '\0'.repeat(301) }));
  const snapshot = { transition: { run_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', target_mode: 'multi' }, rows };
  for (const json of [false, true]) {
    const output = formatAbsorbedPage(snapshot, { limit: 100, json });
    assert.ok(Buffer.byteLength(output) > 16384);
    if (json) assert.equal(JSON.parse(output).data.count, 100);
    else assert.match(output, /count=100 next=100\n$/);
  }
});
test('full text and JSON return complete UTF8 fields with end marker in text mode', t => {
  const { store, query } = fixture(t);
  const originals = ['\0'.repeat(8192), '\u2028'.repeat(2730), '中\n\\\u0085🚀'.repeat(2000), ''];
  const rows = originals.map(content => store.insertConversation('in', 'foo', content || null, content));
  const runId = absorb(store);
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
test('out exclusively creates complete original bytes and returns metadata without field content', t => {
  const { store, query } = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'c4-absorbed-out-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const content = '\0中\n\\🚀\u2028'.repeat(2000), endpoint = 'route\n"\\'.repeat(2000);
  const row = store.insertConversation('in', 'foo', endpoint, content), runId = absorb(store);
  for (const json of [false, true]) for (const field of ['text', 'endpoint']) {
    const out = join(dir, `${field}-${json}.txt`), original = field === 'text' ? content : endpoint;
    const output = query.absorbed({ runId, id: row.id, field, out, json });
    assert.deepEqual(fs.readFileSync(out), Buffer.from(original));
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    if (json) assert.deepEqual(JSON.parse(output), { ok: true, data: { runId, id: row.id, field, bytes: Buffer.byteLength(original), path: out } });
    else assert.equal(output, `absorbed-file run=${runId} id=${row.id} field=${field} bytes=${Buffer.byteLength(original)} path=${out}\n`);
    assert.throws(() => query.absorbed({ runId, id: row.id, field, out, json }), { code: 'INVALID_ARGS' });
    assert.deepEqual(fs.readFileSync(out), Buffer.from(original), 'existing file is not overwritten');
  }
  assert.throws(() => query.absorbed({ runId, id: row.id, out: join(dir, 'missing', 'file') }), { code: 'WRITE_FAILED' });
});
test('out removes partially written destination on driver write failure', t => {
  const { store, query } = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'c4-absorbed-write-fail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const row = store.insertConversation('in', 'foo', 'endpoint', 'full original'), runId = absorb(store), out = join(dir, 'partial.txt');
  const realWrite = fs.writeFileSync;
  let writes = 0;
  t.mock.method(fs, 'writeFileSync', (fd, value, options) => {
    writes++; assert.equal(typeof fd, 'number');
    realWrite(fd, value.slice(0, 2), options);
    throw Object.assign(new Error('controlled disk full'), { code: 'ENOSPC' });
  });
  assert.throws(() => query.absorbed({ runId, id: row.id, out }), { code: 'WRITE_FAILED' });
  assert.equal(writes, 1); assert.equal(fs.existsSync(out), false);
});
test('store mismatch error caps ids at 20 and retains the total before formatting', t => {
  const { db, store } = fixture(t);
  const rows = Array.from({ length: 35 }, () => store.insertConversation('in', 'foo', 'e', 'x'));
  const runId = absorb(store), badIds = rows.map(row => row.id);
  db.prepare("UPDATE conversations SET status='failed'").run();
  db.prepare('DELETE FROM conversations WHERE id=?').run(rows[3].id);
  assert.throws(() => store.queries.readAbsorbed(runId), error => {
    assert.equal(error.code, 'ABSORBED_MISMATCH');
    assert.equal(error.ids.length, 20);
    assert.equal(error.count, badIds.length);
    assert.deepEqual(error.ids, badIds.slice(0, 20));
    return true;
  });
});
test('missing and state-changed absorbed rows reject all formats and export before output', t => {
  const { db, store, query } = fixture(t);
  const rows = Array.from({ length: 35 }, () => store.insertConversation('in', 'foo', 'e', 'x'));
  const runId = absorb(store), badIds = rows.map(row => row.id);
  db.prepare("UPDATE conversations SET status='failed'").run();
  db.prepare('DELETE FROM conversations WHERE id=?').run(rows[3].id);
  const dir = mkdtempSync(join(tmpdir(), 'c4-absorbed-mismatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'never-created.txt');
  for (const json of [false, true]) for (const mode of [{}, { summary: true }, { id: rows[0].id }, { id: rows[0].id, out }]) {
    const result = runAbsorbedQuery(store, { runId, json, ...mode });
    assert.equal(result.exitCode, 1);
    if (json) {
      const { error } = JSON.parse(result.stdout);
      assert.equal(error.code, 'ABSORBED_MISMATCH');
      assert.equal(error.count, 35); assert.deepEqual(error.ids, badIds.slice(0, 20));
      assert.equal(result.stderr, '');
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Error \[ABSORBED_MISMATCH\]/);
      assert.match(result.stderr, /count=35/);
    }
    assert.equal(fs.existsSync(out), false);
  }
  assert.equal(db.inTransaction, false);
  assert.throws(() => query.absorbed({ runId, id: rows[0].id, after: 0 }), { code: 'INVALID_ARGS' });
});
test('limits and conflicting or removed query options are rejected', t => {
  const { store, query } = fixture(t);
  const row = store.insertConversation('in', 'foo', 'e', 'x'), runId = absorb(store);
  const invalidOptions = [
    ...[0, -1, 101, 1.5, NaN, '20'].map(limit => ({ limit })),
    ...[0, -1, 201, 1.5, NaN, '50'].map(limit => ({ summary: true, limit })),
    { maxBytes: 2048 }, { offset: 0 }, { id: row.id, offset: 0 },
    { summary: true, id: row.id }, { summary: true, group: 'foo' }, { summary: true, after: 0 },
    { summary: true, field: 'text' }, { summary: true, out: 'file' },
    { scopeAfter: 'foo' }, { field: 'text' }, { out: 'file' },
    { id: row.id, limit: 1 }, { id: row.id, group: 'foo' }, { id: row.id, after: 0 },
    { id: 0 }, { id: 1.5 }, { after: -1 }, { after: 1.5 },
    { id: row.id, field: 'route' }, { id: row.id, out: '' }, { id: row.id, out: '\0' },
  ];
  for (const options of invalidOptions) assert.throws(() => query.absorbed({ runId, ...options }), { code: 'INVALID_ARGS' }, JSON.stringify(options));
  assert.throws(() => query.absorbed({ runId: 'not-uuid' }), { code: 'INVALID_ARGS' });
  assert.throws(() => query.absorbed({ runId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }), { code: 'RUN_NOT_FOUND' });
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
test('mismatch error lists exactly first 20 ids and retains total count', () => {
  const ids = Array.from({ length: 10000 }, (_, i) => i + 1);
  for (const json of [false, true]) {
    const output = formatQueryError({ code: 'ABSORBED_MISMATCH', message: 'bad', ids }, { json });
    if (json) {
      const { error } = JSON.parse(output);
      assert.equal(error.count, 10000); assert.deepEqual(error.ids, ids.slice(0, 20));
    } else assert.equal(output, `Error [ABSORBED_MISMATCH]: bad ids=${ids.slice(0, 20).join(',')} count=10000\n`);
  }
});
test('summary defaults to 50 scopes and paginates up to 200 in BINARY order without DB writes', t => {
  const { db, store, query } = fixture(t);
  for (let i = 0; i < 205; i++) store.insertConversation('in', 'foo', 'e', 'x', { groupName: `g${String(i).padStart(3, '0')}${'a'.repeat(80)}` });
  const runId = absorb(store), before = db.prepare('SELECT total_changes() AS n').get().n;
  assert.equal(JSON.parse(query.absorbed({ runId, summary: true, json: true })).data.count, 50);
  assert.equal(JSON.parse(query.absorbed({ runId, summary: true, limit: 200, json: true })).data.count, 200);
  for (const json of [false, true]) {
    let scopeAfter; const scopes = [];
    do {
      const output = query.absorbed({ runId, summary: true, scopeAfter, limit: 17, json });
      if (json) {
        const { data } = JSON.parse(output);
        assert.ok(data.count > 0 && data.count <= 17);
        scopes.push(...data.items.map(x => x.scope)); scopeAfter = data.nextScope ?? undefined;
      } else {
        const page = [...output.matchAll(/^scope=(\S+) count=/gm)].map(m => m[1]);
        scopes.push(...page);
        const footer = output.match(/count=(\d+) nextScope=(\S+)\n$/);
        assert.equal(Number(footer[1]), page.length); assert.ok(page.length <= 17);
        scopeAfter = footer[2] === 'none' ? undefined : footer[2];
      }
    } while (scopeAfter);
    assert.equal(scopes.length, 205); assert.equal(new Set(scopes).size, 205); assert.deepEqual(scopes, [...scopes].sort());
  }
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before); assert.equal(db.inTransaction, false);
});
test('single-target summary caps source group listing at 50 with remaining count', t => {
  const { store, query } = fixture(t);
  for (let i = 0; i < 53; i++) store.insertConversation('in', 'foo', 'e', 'x', { groupName: `g${String(i).padStart(2, '0')}` });
  const runId = absorb(store, 'multi', 'single');
  const item = JSON.parse(query.absorbed({ runId, summary: true, json: true })).data.items[0];
  assert.equal(item.count, 53); assert.equal(Object.keys(item.bySourceGroup).length, 50);
  assert.deepEqual(Object.keys(item.bySourceGroup), Array.from({ length: 50 }, (_, i) => `foo:g${String(i).padStart(2, '0')}`));
  assert.equal(item.bySourceGroupMore, 3);
  const text = query.absorbed({ runId, summary: true });
  assert.match(text, /foo:g49:1,\+3 more\n/); assert.ok(!text.includes('foo:g50'));
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
test('single-target summary counts legal constructor namespace in JSON and text', t => {
  const { store, query } = fixture(t);
  const rows = ['constructor', 'chat', 'constructor'].map(group =>
    store.insertConversation('in', group, 'e', 'x'));
  const runId = absorb(store, 'multi', 'single');
  const options = { runId, summary: true };
  const item = JSON.parse(query.absorbed({ ...options, json: true })).data.items[0];
  assert.deepEqual(item.bySourceGroup, { constructor: 2, chat: 1 });
  assert.equal(item.count, 3);
  assert.equal(item.firstId, rows[0].id);
  assert.equal(item.lastId, rows[2].id);
  const text = query.absorbed(options);
  assert.match(text, /bySourceGroup=chat:1,constructor:2\n/);
  assert.ok(!text.includes('[native code]'));
});
