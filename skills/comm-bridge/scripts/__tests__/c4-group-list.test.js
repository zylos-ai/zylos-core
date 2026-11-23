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
  seed('lark:oc_99', '2026-01-03 01:00:00', 'newest match');
  seed('lark:recent1', '2026-01-30 00:00:00', 'preview only');
  seed('lark:recent2', '2026-01-30T01:00:00Z', '🙂'.repeat(90));
  seed('origin', '2026-01-30 02:00:00');
  db.exec("INSERT INTO channel_namespaces VALUES('lark','feishu')");
  return { db, seed, store: createStore(db) };
}

test('default and legacy matching output keep the previous reader\'s fields byte for byte and add only the preview message and Origin\'s processing source', t => {
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
    const rows = store.queries.listGroups(options);
    for (const row of rows) if (row.preview) assert.ok(Object.hasOwn(row.preview, 'message'), 'every preview carries the reader message');
    for (const row of rows) assert.equal(Object.hasOwn(row, 'processingSource'), row.sessionGroup === 'origin', row.sessionGroup);
    const withoutMessage = rows.map(({ processingSource, ...row }) => row.preview ? { ...row, preview: Object.fromEntries(Object.entries(row.preview).filter(([key]) => !['message', 'messageSource', 'messageRaw'].includes(key))) } : row);
    assert.equal(JSON.stringify(withoutMessage), JSON.stringify(legacyListGroups(options)));
  }
});
