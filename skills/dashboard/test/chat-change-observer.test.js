import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { C4Reader } from '../src/lib/c4-reader.js';
import { ChatHistory } from '../src/lib/chat/history.js';
import { ChatChangeObserver, parseChatSubscription } from '../src/lib/chat/change-observer.js';
import { migrateSchema } from '../../comm-bridge/scripts/c4-migrations.js';
import { migrateToV2 } from '../../comm-bridge/scripts/c4-migrations-v2.js';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

const idFor = group => 'g:' + Buffer.from(group).toString('hex').toUpperCase();
const gate = { skip: !chatEnabled(), timeout: 15000 };
function clock() {
  let id = 0;
  const tasks = new Map();
  return { setTimeout(fn) { tasks.set(++id, fn); return id; }, clearTimeout(id) { tasks.delete(id); },
    tick() { const batch = [...tasks.values()]; tasks.clear(); for (const fn of batch) fn(); }, count: () => tasks.size };
}
function createDb(file) {
  const db = new Database(file);
  migrateSchema(db, { isNew: true }); migrateToV2(db);
  db.prepare('INSERT INTO channel_namespaces VALUES (?,?)').run('dash', 'dashboard');
  return db;
}
function fixture(t) {
  const sandbox = createChatSandbox(t);
  sandbox.assertIsolation();
  const writer = createDb(sandbox.paths.c4Db);
  const reader = new C4Reader(sandbox.paths.zylos);
  const history = new ChatHistory({ c4Reader: reader });
  const timers = clock();
  const observer = new ChatChangeObserver({ c4Reader: reader, history, ...timers });
  const write = row => writer.prepare(`INSERT INTO conversations
    (id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES (@id,'2026-01-01 12:00:00',@direction,@channel,@endpoint,@group,@content,@status)`).run({
    direction: 'in', channel: 'dashboard', endpoint: 'one', group: 'dash:one',
    content: 'private body should never enter events', status: 'pending', ...row });
  const streams = [];
  const subscribe = (options = { tab: 'mine', conversationId: idFor('dash:one'), ids: [1] }) => {
    const record = { events: [], stopped: [], allowed: true };
    record.off = observer.subscribe(options, { validate: () => record.allowed,
      send: (event, data) => { assert.ok(record.events.length < 30); record.events.push({ event, data }); },
      onStop: reason => record.stopped.push(reason) });
    streams.push(record); return record;
  };
  t.after(() => { observer.close(); reader.close(); if (writer.open) writer.close(); });
  return { sandbox, writer, reader, history, observer, timers, write, subscribe };
}

// Real C4 SQLite with an independent writer and read-only observer connection.
// Run for observer/scope/version changes; unrelated rendering can skip. The gate
// and sandbox read back HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket/DB
// before access; no HTTP/model/PM2/tmux. t.after owns DBs, loop and private root.
test('committed inserts and status updates emit bounded dirty hints while rollback stays silent', gate, t => {
  const f = fixture(t); f.writer.pragma('journal_mode = WAL'); f.write({ id: 1 });
  const stream = f.subscribe();
  const mainFileTime = fs.statSync(f.sandbox.paths.c4Db).mtimeMs;
  assert.equal(stream.events[0].event, 'chat_ready');
  assert.deepEqual(stream.events[0].data, { version: 1, tab: 'mine', conversationId: idFor('dash:one'), ids: [1] });
  assert.equal(f.reader._db.pragma('query_only', { simple: true }), 1);
  assert.throws(() => f.reader._db.exec('DELETE FROM conversations'), /readonly/);
  f.writer.exec('BEGIN'); f.write({ id: 2, direction: 'out', status: 'delivered' });
  f.timers.tick(); assert.equal(stream.events.length, 1);
  f.writer.exec('ROLLBACK'); f.timers.tick(); assert.equal(stream.events.length, 1);
  f.write({ id: 3, direction: 'out', status: 'delivered' });
  f.timers.tick(); assert.equal(stream.events.at(-1).event, 'chat_messages_changed');
  f.writer.prepare("UPDATE conversations SET status='delivered' WHERE id=1").run();
  f.timers.tick(); assert.equal(stream.events.at(-1).event, 'chat_delivery_changed');
  const payload = JSON.stringify(stream.events);
  for (const forbidden of ['private body', 'content', 'preview', 'timestamp', 'status', 'endpoint', 'attachment']) assert.equal(payload.includes(forbidden), false);
  assert.equal(stream.events.filter(row => row.event === 'chat_delivery_changed').length, 1);
  const visibleEvents = stream.events.length;
  f.write({ id: 4, channel: 'internal', group: 'private:other' }); f.timers.tick();
  assert.equal(stream.events.length, visibleEvents, 'excluded activity cannot produce chat hints');
  assert.equal(fs.statSync(f.sandbox.paths.c4Db).mtimeMs, mainFileTime, 'WAL commits need not modify the main database mtime');
});

test('two clients share one sampler and one scope snapshot per changed pass', gate, t => {
  const f = fixture(t); f.write({ id: 1 });
  let versions = 0, snapshots = 0;
  const readVersion = f.reader.readVersion.bind(f.reader), snapshot = f.history.chatChangeSnapshot.bind(f.history);
  f.reader.readVersion = () => { versions++; return readVersion(); };
  f.history.chatChangeSnapshot = (options, window) => { snapshots++; return snapshot(options, window); };
  assert.equal(f.timers.count(), 0); f.timers.tick(); assert.equal(versions, 0);
  const a = f.subscribe(), b = f.subscribe();
  assert.equal(f.timers.count(), 1);
  const initial = snapshots, reads = versions;
  f.timers.tick(); assert.equal(snapshots, initial); assert.equal(versions, reads + 1);
  f.write({ id: 2, direction: 'out', status: 'delivered' });
  f.timers.tick(); assert.equal(snapshots, initial + 1);
  assert.equal(a.events.at(-1).event, 'chat_messages_changed'); assert.equal(b.events.at(-1).event, 'chat_messages_changed');
  a.off(); assert.equal(f.timers.count(), 1); b.off(); assert.equal(f.timers.count(), 0);
  const stopped = versions; f.timers.tick(); assert.equal(versions, stopped);
  let emitted = 0;
  f.observer.subscribe({ tab: 'mine', conversationId: idFor('dash:one'), ids: [1] }, {
    validate: () => true, send: () => { emitted++; f.observer.close(); } });
  assert.equal(emitted, 1); assert.equal(f.timers.count(), 0);
  f.timers.tick(); assert.equal(emitted, 1);
});

test('authorization is rechecked without commits and before every emitted hint', gate, t => {
  const f = fixture(t); f.write({ id: 1 });
  const stream = f.subscribe(); stream.allowed = false;
  f.timers.tick(); assert.deepEqual(stream.stopped, ['chat_access_revoked']);
  assert.equal(f.timers.count(), 0); assert.equal(stream.events.length, 1);
  let attempts = 0, stopped = 0;
  f.observer.subscribe({ tab: 'mine', conversationId: idFor('dash:one'), ids: [1] }, {
    validate: () => ++attempts === 1, send: () => assert.fail('revoked subscription leaked an event'), onStop: () => stopped++ });
  assert.equal(stopped, 1); assert.equal(f.timers.count(), 0);
});

test('database replacement invalidates streams and a new subscription baselines the replacement', gate, t => {
  const f = fixture(t); f.write({ id: 1 }); const stream = f.subscribe();
  f.writer.close();
  const replacement = path.join(f.sandbox.root, 'replacement.db');
  const second = createDb(replacement);
  second.prepare(`INSERT INTO conversations (id,direction,channel,endpoint_id,session_group,content,status)
    VALUES (10,'in','dashboard','one','dash:one','replacement private','pending')`).run(); second.close();
  fs.renameSync(replacement, f.sandbox.paths.c4Db);
  f.timers.tick(); assert.deepEqual(stream.stopped, ['chat_unavailable']); assert.equal(f.timers.count(), 0);
  const fresh = f.subscribe({ tab: 'mine', conversationId: idFor('dash:one'), ids: [10] });
  assert.equal(fresh.events[0].event, 'chat_ready'); assert.equal(f.reader._generation, 2);
});

test('unreadable or missing database stops polling and recovery requires a readable baseline', gate, t => {
  const f = fixture(t); f.write({ id: 1 }); const stream = f.subscribe(); f.writer.close();
  fs.renameSync(f.sandbox.paths.c4Db, f.sandbox.paths.c4Db + '.saved');
  f.timers.tick(); assert.equal(stream.stopped[0], 'chat_unavailable'); assert.equal(f.timers.count(), 0);
  const unavailable = f.subscribe(); assert.equal(unavailable.events.length, 0); assert.equal(unavailable.stopped[0], 'chat_unavailable');
  fs.renameSync(f.sandbox.paths.c4Db + '.saved', f.sandbox.paths.c4Db);
  const recovered = f.subscribe(); assert.equal(recovered.events[0].event, 'chat_ready');
  fs.renameSync(f.sandbox.paths.c4Db, f.sandbox.paths.c4Db + '.valid');
  fs.writeFileSync(f.sandbox.paths.c4Db, 'corrupt replacement');
  f.timers.tick(); assert.equal(recovered.stopped[0], 'chat_unavailable');
  const corrupt = f.subscribe(); assert.equal(corrupt.events.length, 0); assert.equal(corrupt.stopped[0], 'chat_unavailable');
  f.observer.close(); assert.equal(f.timers.count(), 0); assert.equal(recovered.stopped[0], 'chat_unavailable');
  assert.equal(f.observer.subscriptions.size, 0);
});

test('metadata snapshots share history visibility and reject foreign watched IDs', gate, t => {
  const f = fixture(t); f.write({ id: 1 });
  for (const [i, channel] of ['void', 'internal', 'system', 'scheduler', 'control'].entries()) f.write({ id: 10 + i, channel });
  f.write({ id: 20, group: 'origin' }); f.write({ id: 21, group: '*' });
  f.write({ id: 22, group: 'unowned:one' }); f.write({ id: 23, direction: 'other' });
  f.write({ id: 24, channel: 'telegram', group: 'telegram:one' });
  const own = f.history.chatChangeSnapshot({ tab: 'mine', conversationId: idFor('dash:one'), ids: [1] }, { afterId: 0 });
  assert.equal(own.listChanged, true); assert.equal(own.latestId, 1); assert.equal(own.highwater, 24);
  const external = f.history.chatChangeSnapshot({ tab: 'external' }, { afterId: 23 }); assert.equal(external.listChanged, true);
  const hiddenOnly = f.history.chatChangeSnapshot({ tab: 'mine' }, { afterId: 1 }); assert.equal(hiddenOnly.listChanged, false);
  assert.throws(() => f.history.chatChangeSnapshot({ tab: 'mine', conversationId: idFor('telegram:one') }), /chat_conversation_not_found/);
  assert.throws(() => f.history.chatChangeSnapshot({ tab: 'mine', conversationId: idFor('dash:one'), ids: [24] }), /chat_message_not_found/);
  f.writer.transaction(() => { for (let i = 100; i < 300; i++) f.write({ id: i, direction: 'out', status: 'delivered' }); })();
  const bounded = f.history.chatChangeSnapshot({ tab: 'mine', conversationId: idFor('dash:one'), ids: [1] }, { afterId: 24 });
  assert.equal(bounded.listChanged, true); assert.equal(bounded.highwater, 299); assert.equal(bounded.latestId, 299); assert.equal(bounded.delivery.length, 1);
  const baseline = f.history.chatChangeSnapshot({ tab: 'mine' }); assert.equal(baseline.listChanged, false);
  assert.throws(() => f.history.chatChangeSnapshot({ tab: 'mine' }, { afterId: 300 }), /chat_history_unavailable/);
});

test('chat subscription query is explicit and strictly bounded', () => {
  assert.equal(parseChatSubscription(new URLSearchParams()), null);
  assert.deepEqual(parseChatSubscription(new URLSearchParams('chat=1&chat_tab=mine&chat_conversation=g:646173683A6F6E65&chat_ids=8,2')),
    { tab: 'mine', conversationId: 'g:646173683A6F6E65', ids: [2, 8] });
  for (const query of ['chat=0', 'chat=1&chat=1', 'chat=1&chat_tab=other', 'chat=1&chat_ids=1',
    'chat=1&chat_conversation=d:one', 'chat=1&chat_conversation=g:ff', 'chat=1&chat_conversation=g:FF&chat_ids=1,1',
    'chat=1&chat_tab=external&chat_conversation=g:FF&chat_ids=1', 'chat=1&chat_conversation=g:FF&chat_ids=0',
    'chat=1&chat_conversation=g:FF&chat_ids=' + Array.from({ length: 101 }, (_, i) => i + 1).join(',')]) {
    assert.throws(() => parseChatSubscription(new URLSearchParams(query)), error => error.statusCode === 400, query);
  }
});

// Real INSERT windows prove historical excluded rows are never rescanned.
// Run for frontier/scope changes under the same gated private DB lifecycle.
test('incremental list hints survive large excluded tails without leaking hidden-only commits', gate, t => {
  const f = fixture(t); f.write({ id: 1 });
  const stream = f.subscribe({ tab: 'mine', conversationId: null, ids: [] });
  f.writer.transaction(() => {
    f.write({ id: 2, endpoint: 'two', group: 'dash:two' });
    for (let id = 3; id <= 1500; id++) f.write({ id, channel: 'internal', group: 'private:internal' });
  })();
  f.timers.tick(); assert.equal(stream.events.at(-1).event, 'chat_messages_changed');
  const count = stream.events.length;
  f.writer.transaction(() => { for (let id = 1501; id <= 2500; id++) f.write({ id, channel: 'internal', group: 'private:internal' }); })();
  f.timers.tick(); assert.equal(stream.events.length, count);
});

test('clients joining at different frontiers receive separate readable baselines', gate, t => {
  const f = fixture(t); f.write({ id: 1 });
  const options = { tab: 'mine', conversationId: null, ids: [] };
  const first = f.subscribe(options), windows = [];
  const snapshot = f.history.chatChangeSnapshot.bind(f.history);
  f.history.chatChangeSnapshot = (options, window) => { windows.push(window.afterId); return snapshot(options, window); };
  f.write({ id: 2, endpoint: 'two', group: 'dash:two' });
  const second = f.subscribe(options);
  assert.deepEqual(windows, [1, null]);
  assert.equal(first.events.at(-1).event, 'chat_messages_changed');
  assert.deepEqual(second.events.map(row => row.event), ['chat_ready']);
  f.timers.tick(); assert.equal(windows.length, 2);
});

// Representative query cost: baseline MAX uses SQLite's min/max optimization;
// subsequent list checks search only new primary-key ranges. No bodies or
// historical groups are loaded, and all fixture writes are private and bounded.
test('incremental metadata queries use primary-key windows at representative C4 sizes', gate, t => {
  const f = fixture(t);
  const insert = f.writer.prepare(`INSERT INTO conversations
    (id,timestamp,direction,channel,endpoint_id,session_group,content,status)
    VALUES (?,'2026-01-01 12:00:00','in',?,?,?,'representative private body','pending')`);
  const addRange = f.writer.transaction((start, end, hidden = false) => {
    for (let i = start; i <= end; i++) {
      const channel = hidden ? 'internal' : i % 5 === 0 ? 'telegram' : 'dashboard';
      const endpoint = 'g' + i % 200;
      insert.run(i, channel, endpoint, hidden ? 'private:internal' : channel === 'dashboard' ? 'dash:' + endpoint : 'telegram:' + endpoint);
    }
  });
  const subscriptions = [
    { tab: 'mine', conversationId: idFor('dash:g1'), ids: Array.from({ length: 100 }, (_, i) => 1 + i * 200) },
    { tab: 'external', conversationId: null, ids: [] },
  ];
  addRange(1, 100000);
  const outputs = [], listPlans = {}, baselineMs = {};
  const query = f.history._query.bind(f.history);
  f.history._query = (sql, parameters) => {
    const rows = query(sql, parameters);
    if (sql.includes('c.id>@afterId')) {
      const tab = sql.includes("c.channel='dashboard'") ? 'mine' : 'external';
      if (!listPlans[tab]) listPlans[tab] = f.reader._db.prepare('EXPLAIN QUERY PLAN ' + sql).all(parameters).map(row => row.detail);
    }
    return rows;
  };
  for (const hidden of [false, true]) {
    let highwater = query('SELECT COALESCE(MAX(id),0) AS id FROM conversations', {})[0].id;
    if (hidden) { addRange(highwater + 1, highwater + 100000, true); highwater += 100000; }
    for (const options of subscriptions) {
      const start = performance.now(); const baseline = f.history.chatChangeSnapshot(options); baselineMs[options.tab] = performance.now() - start;
      assert.equal(baseline.highwater, highwater); assert.equal(baseline.listChanged, false);
      let previous = baseline;
      const samples = [];
      for (let i = 0; i < 25; i++) {
        const channel = i % 3 === 0 ? 'internal' : options.tab === 'mine' ? 'dashboard' : 'telegram';
        const endpoint = 'new';
        insert.run(null, channel, endpoint, channel === 'dashboard' ? 'dash:new' : channel === 'telegram' ? 'telegram:new' : 'private:internal');
        const start = performance.now(); const snapshot = f.history.chatChangeSnapshot(options, { afterId: previous.highwater }); samples.push(performance.now() - start);
        assert.equal(snapshot.listChanged, channel !== 'internal');
        assert.equal(snapshot.latestId, options.tab === 'mine' ? 99801 : null);
        assert.equal(snapshot.delivery.length, options.tab === 'mine' ? 100 : 0);
        previous = snapshot;
      }
      samples.sort((a, b) => a - b);
      outputs.push({ tab: options.tab, rows: previous.highwater, historicalExcludedTail: hidden ? 100000 : 0,
        samples: samples.length, meanMs: samples.reduce((a, b) => a + b, 0) / samples.length, p95Ms: samples[23], maxMs: samples.at(-1) });
      highwater = previous.highwater;
    }
  }
  const maxPlan = f.reader._db.prepare('EXPLAIN QUERY PLAN SELECT COALESCE(MAX(id),0) AS id FROM conversations').all().map(row => row.detail);
  const selectedPlan = f.reader._db.prepare(`EXPLAIN QUERY PLAN SELECT c.id FROM conversations c
    WHERE c.session_group=? ORDER BY c.id DESC LIMIT 1`).all('dash:g1').map(row => row.detail);
  assert.ok(selectedPlan.some(value => value.includes('idx_conv_group_id')));
  for (const plan of Object.values(listPlans)) assert.ok(plan.some(value => /SEARCH c USING INTEGER PRIMARY KEY/.test(value)));
  assert.ok(maxPlan.some(value => value.includes('SEARCH conversations')));
  console.info('chat observer query costs', JSON.stringify({ results: outputs, baselineMs, listPlans, maxPlan, selectedPlan,
    boundary: 'Only newly committed ID ranges are searched; historical rows are not rescanned. No fixed bound on rows inserted between two samples.' }));
});
