import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { parseSessionGroup, dataError } from '../c4-session-group.js';

function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close()); guardDatabase(db, owner);
  const insert = db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group,timestamp) VALUES('in','lark',?,'delivered',?,?)");
  const head = db.prepare('INSERT INTO group_heads VALUES(?,?)');
  function seed(group, timestamp, content = group) { head.run(group, insert.run(content, group, timestamp).lastInsertRowid); }
  db.transaction(() => { for (let i = 0; i < 1000; i++) seed('old:' + i, '2026-01-01 00:00:00'); })();
  seed('lark:oc_77', '2026-01-01 01:00:00', 'old match');
  seed('lark:OC_88', '2026-01-02 01:00:00', 'newer match');
  seed('lark:recent1', '2026-01-30 00:00:00', 'preview only');
  seed('lark:recent2', '2026-01-30T01:00:00Z', '🙂'.repeat(90));
  seed('origin', '2026-01-30 02:00:00');
  db.exec("INSERT INTO channel_namespaces VALUES('lark','feishu')");
  return { db, seed, store: createStore(db) };
}
const cutoff = Date.parse('2026-01-24T00:00:00Z');

test('activity cutoff returns recent groups, boundary and exact remaining flag', t => {
  const { db, store } = fixture(t);
  const result = store.queries.listGroups({ activeSince: cutoff });
  assert.deepEqual(result.groups.map(row => row.sessionGroup), ['origin', 'lark:recent2', 'lark:recent1']);
  assert.equal(result.hasOlder, true);
  assert.deepEqual(store.queries.listGroups({ activeSince: cutoff, limit: 2 }), { groups: result.groups.slice(0, 2), hasOlder: true });
  assert.equal(store.queries.listGroups({ activeSince: Date.parse('2026-01-30T02:00:00Z') }).groups.length, 1);
  assert.deepEqual(store.queries.listGroups({ activeSince: Date.parse('2026-01-31T00:00:00Z') }), { groups: [], hasOlder: true });
  db.exec("DELETE FROM group_heads WHERE head_id < (SELECT min(head_id) FROM group_heads WHERE session_group LIKE '%recent%' OR session_group='origin')");
  assert.deepEqual(store.queries.listGroups({ activeSince: cutoff }), { ...result, hasOlder: false });
  assert.equal(store.queries.listGroups({ activeSince: cutoff, limit: 3 }).hasOlder, false);
  db.exec('DELETE FROM group_heads');
  assert.deepEqual(store.queries.listGroups({ activeSince: cutoff }), { groups: [], hasOlder: false });
});

test('key search is case insensitive and ordered by latest head without matching preview text', t => {
  const { store } = fixture(t);
  const rows = store.queries.listGroups({ keyMatch: 'oc_' });
  assert.deepEqual(rows.map(row => row.sessionGroup), ['lark:OC_88', 'lark:oc_77']);
  assert.deepEqual(store.queries.listGroups({ keyMatch: 'OC_' }), rows);
  assert.deepEqual(store.queries.listGroups({ keyMatch: 'oc_', limit: 1 }), rows.slice(0, 1));
  assert.deepEqual(store.queries.listGroups({ keyMatch: 'preview only' }), []);
  assert.equal(store.queries.listGroups({ match: 'preview only' }).length, 1);
  assert.equal(rows[0].componentName, 'feishu');
});

test('default and legacy matching output remain byte compatible with the previous reader', t => {
  const { db: c, store } = fixture(t);
  const all = (db, sql, ...args) => db.prepare(sql).all(...args);
  const get = (db, sql, ...args) => db.prepare(sql).get(...args);
  function legacyListGroups({ match, limit } = {}) {
    if (match !== undefined && typeof match !== 'string') throw dataError('INVALID_ARGS', 'match must be a string');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw dataError('INVALID_ARGS', 'limit must be positive');
    return (() => {
      const result = [];
      for (const head of all(c, 'SELECT h.session_group,c.timestamp FROM group_heads h JOIN conversations c ON c.id=h.head_id ORDER BY h.head_id DESC')) {
        const preview = get(c, "SELECT timestamp,channel,endpoint_id,content FROM conversations WHERE session_group=? AND direction='in' AND channel<>'internal' ORDER BY id DESC LIMIT 1", head.session_group);
        const text = preview ? [...preview.content].slice(0, 80).join('') : null;
        if (match !== undefined && !head.session_group.toLowerCase().includes(match.toLowerCase()) && !(text ?? '').toLowerCase().includes(match.toLowerCase())) continue;
        const parsed = parseSessionGroup(head.session_group);
        const componentName = parsed && parsed.namespace !== 'origin' ? get(c, 'SELECT component_name FROM channel_namespaces WHERE namespace=?', parsed.namespace)?.component_name ?? null : null;
        const millis = value => Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
        result.push({ sessionGroup: head.session_group, componentName, sessionGroupName: parsed?.groupName ?? null, lastActivityAt: millis(head.timestamp), preview: preview ? { timestamp: millis(preview.timestamp), channel: preview.channel, endpoint: preview.endpoint_id, text } : null });
        if (result.length === limit) break;
      }
      return result;
    })();
  }

  for (const options of [{}, { limit: 2 }, { match: 'preview' }, { match: 'LARK:OC_', limit: 1 }, { match: 'missing' }]) {
    assert.equal(JSON.stringify(store.queries.listGroups(options)), JSON.stringify(legacyListGroups(options)));
  }
});

test('store rejects invalid and conflicting filters before reading', t => {
  const { store } = fixture(t);
  for (const options of [{ activeSince: -1 }, { activeSince: 1.5 }, { activeSince: '1' }, { activeSince: NaN }, { keyMatch: '' }, { keyMatch: '  ' }, { keyMatch: 1 }, { match: 'a', keyMatch: 'b' }, { match: '', activeSince: 0 }, { keyMatch: 'a', activeSince: 0 }, { limit: 0 }]) {
    assert.throws(() => store.queries.listGroups(options), { code: 'INVALID_ARGS' });
  }
});
