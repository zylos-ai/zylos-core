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
  assert.deepEqual(rows.map(row => row.sessionGroup), ['lark:oc_99', 'lark:OC_88', 'lark:oc_77']);
  assert.deepEqual(store.queries.listGroups({ keyMatch: 'OC_' }), rows);
  assert.deepEqual(store.queries.listGroups({ keyMatch: 'oc_', limit: 1 }).map(row => row.sessionGroup), ['lark:oc_99']);
  assert.deepEqual(store.queries.listGroups({ keyMatch: 'preview only' }), []);
  assert.equal(store.queries.listGroups({ match: 'preview only' }).length, 1);
  assert.equal(rows[0].componentName, 'feishu');
});

test('key search puts the group whose key equals the search first, ahead of many newer groups containing it', t => {
  const { seed, store } = fixture(t);
  seed('lark:oc_1', '2026-01-04 00:00:00', 'parent');
  for (let i = 0; i < 60; i++) seed('lark:oc_1_thread_' + i, '2026-01-05 00:00:00', 'thread');
  assert.deepEqual(store.queries.listGroups({ keyMatch: 'lark:oc_1', limit: 1 }).map(row => row.sessionGroup), ['lark:oc_1']);
  const rows = store.queries.listGroups({ keyMatch: 'lark:oc_1', limit: 3 }).map(row => row.sessionGroup);
  assert.deepEqual(rows, ['lark:oc_1', 'lark:oc_1_thread_59', 'lark:oc_1_thread_58'], 'the others stay newest first');
  // Equality is exact; a search in other letter case has no exact group and returns the newest match.
  assert.deepEqual(store.queries.listGroups({ keyMatch: 'LARK:OC_1', limit: 1 }).map(row => row.sessionGroup), ['lark:oc_1_thread_59']);
});

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

test('a group preview names where a message came from when it is not a person\'s own words', t => {
  const { seed, store } = fixture(t);
  seed('scheduler:main', '2026-02-01 00:00:00', '[Scheduled Task: task-ab12cd34 #2]\nnightly digest\n\n---- After completing this task, run: node cli.js done task-ab12cd34');
  seed('lark:oc_tags', '2026-02-01 00:01:00', '[Release bot] build 01a1c33d-7d4e-7a1b-9c2d-0123456789ab shipped');
  const rows = Object.fromEntries(store.queries.listGroups({ limit: 4 }).map(row => [row.sessionGroup, row.preview]));
  assert.equal(rows['scheduler:main'].message, 'nightly digest');
  assert.deepEqual(rows['scheduler:main'].messageSource, { kind: 'scheduled_task', taskId: 'task-ab12cd34' });
  assert.equal(rows['lark:oc_tags'].message, 'build shipped');
  assert.deepEqual(rows['lark:oc_tags'].messageSource, { kind: 'header' });
  assert.equal(Object.hasOwn(rows['origin'], 'messageSource'), false);
  assert.equal(rows['lark:recent2'].message, '🙂'.repeat(79) + '…');
  assert.equal(Object.hasOwn(rows['lark:recent2'], 'messageSource'), false);
  // The stored start comes only on request.
  for (const key of ['scheduler:main', 'lark:oc_tags']) assert.equal(Object.hasOwn(rows[key], 'messageRaw'), false);
  const raw = Object.fromEntries(store.queries.listGroups({ limit: 4, raw: true }).map(row => [row.sessionGroup, row.preview]));
  // Labelled previews carry the stored start, line breaks kept; a person's own words carry none.
  assert.equal(raw['scheduler:main'].messageRaw, '[Scheduled Task: task-ab12cd34 #2]\nnightly digest\n\n---- After completing this task, run: node cli.js done task-ab12cd34');
  assert.equal(raw['lark:oc_tags'].messageRaw, '[Release bot] build 01a1c33d-7d4e-7a1b-9c2d-0123456789ab shipped');
  assert.equal(raw['scheduler:main'].message, rows['scheduler:main'].message);
  for (const key of ['origin', 'lark:recent2']) assert.equal(Object.hasOwn(raw[key], 'messageRaw'), false);
  for (const value of [1, 'yes', null]) assert.throws(() => store.queries.listGroups({ raw: value }), { code: 'INVALID_ARGS' });
});

test('Origin\'s processing source names a scheduled task only while no control item has run since the task was stored', t => {
  const { db } = fixture(t);
  // One clock for the store and the stored message, as in production: conversation timestamps are UTC text,
  // control_queue times are the store's Unix seconds.
  let clock = Date.parse('2026-02-01T00:00:00.400Z');
  const store = createStore(db, { now: () => clock });
  const at = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const later = seconds => { clock += seconds * 1000; };
  const task = '[Scheduled Task: task-ab12cd34 #2]\nnightly digest\n\n---- After completing this task, run: node cli.js done task-ab12cd34';
  const message = (content, status, channel = 'system') => db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group,timestamp) VALUES('in',?,?,?,'origin',?)")
    .run(channel, content, status, at(clock)).lastInsertRowid;
  const control = () => store.insertControl('Memory sync', { sessionGroup: 'origin', ackDeadlineAt: Math.floor(clock / 1000) + 600 }).id;
  // Marked done the way the acknowledgement does it: status and the store's current second.
  const done = id => db.prepare("UPDATE control_queue SET status='done',updated_at=? WHERE id=?").run(Math.floor(clock / 1000), id);
  const source = () => store.queries.listGroups({ limit: 2 }).find(row => row.sessionGroup === 'origin').processingSource;

  const handed = message(task, 'delivered');
  assert.equal(source(), 'scheduled_task');
  later(5);
  const sync = control();
  assert.equal(source(), 'scheduled_task', 'a control item still waiting is not being handled');
  assert.ok(store.claimControl(sync));
  assert.equal(source(), null, 'a control item handed to Origin');
  later(15); done(sync);
  assert.equal(source(), null, 'a control item handled after the task: Origin may be done with the task');
  // A pending owner message queued behind the task does not change it.
  db.prepare('DELETE FROM control_queue').run();
  message('are the alerts handled?', 'pending', 'dashboard');
  assert.equal(source(), 'scheduled_task');
  // Handled in the same second as the task's stored time counts as after it.
  clock = Date.parse('2026-02-01T00:00:00.900Z');
  const sameSecond = control(); assert.ok(store.claimControl(sameSecond)); done(sameSecond);
  assert.equal(source(), null, 'same second');
  db.prepare('DELETE FROM control_queue').run();
  // An older control item handled before the task does not count.
  clock = Date.parse('2026-01-31T23:59:58.000Z');
  const earlier = control(); assert.ok(store.claimControl(earlier)); done(earlier);
  assert.equal(source(), 'scheduled_task', 'handled before the task');
  // A control item for no group (single mode) running counts too.
  db.prepare("INSERT INTO control_queue(raw_content,content,status,created_at,updated_at,session_group) VALUES('health','health','running',?,?,NULL)")
    .run(Math.floor(clock / 1000), Math.floor(clock / 1000));
  assert.equal(source(), null, 'a control item for no group');
  db.prepare('DELETE FROM control_queue').run();
  const handing = message('next', 'running', 'dashboard');
  assert.equal(source(), null, 'a message being handed over');
  db.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(handing);
  assert.equal(source(), null, 'the owner message is the one in hand');
  db.prepare('DELETE FROM conversations WHERE id>?').run(handed);
  db.prepare("UPDATE conversations SET status='pending' WHERE id=?").run(handed);
  assert.equal(source(), null, 'nothing handed yet');
});

test('a long labelled message keeps at most 2000 characters of its start, without a cut token', t => {
  const { seed, store } = fixture(t);
  const secret = 'sk-' + 'w'.repeat(40);
  seed('lark:oc_long', '2026-02-01 00:00:00', '[Report bot] daily\n' + 'b'.repeat(1975) + ' ' + secret + ' end');
  const preview = store.queries.listGroups({ limit: 1, raw: true })[0].preview;
  assert.equal(preview.messageRaw, '[Report bot] daily\n' + 'b'.repeat(1975) + '…');
  assert.equal(preview.messageRaw.includes('sk-'), false);
  assert.equal(Object.hasOwn(store.queries.listGroups({ limit: 1 })[0].preview, 'messageRaw'), false);
});

test('on core\'s own direct channels a stored message starting with brackets stays the person\'s words', t => {
  const { db, store } = fixture(t);
  const insert = db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group,timestamp) VALUES('in',?,?,'delivered',?,'2026-02-01 00:00:00')");
  const head = db.prepare('INSERT INTO group_heads VALUES(?,?)');
  head.run('dashboard:c1', insert.run('dashboard', '[urgent] call me back', 'dashboard:c1').lastInsertRowid);
  head.run('multica:t1', insert.run('multica', '[urgent] call me back', 'multica:t1').lastInsertRowid);
  const rows = Object.fromEntries(store.queries.listGroups({ limit: 2 }).map(row => [row.sessionGroup, row.preview]));
  assert.equal(rows['dashboard:c1'].message, '[urgent] call me back');
  assert.equal(Object.hasOwn(rows['dashboard:c1'], 'messageSource') || Object.hasOwn(rows['dashboard:c1'], 'messageRaw'), false);
  assert.equal(rows['multica:t1'].message, 'call me back');
  assert.deepEqual(rows['multica:t1'].messageSource, { kind: 'header' });
});

test('store rejects invalid and conflicting filters before reading', t => {
  const { store } = fixture(t);
  for (const options of [{ activeSince: -1 }, { activeSince: 1.5 }, { activeSince: '1' }, { activeSince: NaN }, { keyMatch: '' }, { keyMatch: '  ' }, { keyMatch: 1 }, { match: 'a', keyMatch: 'b' }, { match: '', activeSince: 0 }, { keyMatch: 'a', activeSince: 0 }, { limit: 0 }]) {
    assert.throws(() => store.queries.listGroups(options), { code: 'INVALID_ARGS' });
  }
});
