import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
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
  const subscribe = (options = { tab: 'mine', conversationId: idFor('dash:one') }) => {
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
  f.observer.subscribe({ tab: 'mine', conversationId: idFor('dash:one') }, {
    validate: () => true, send: () => { emitted++; f.observer.close(); } });
  assert.equal(emitted, 1); assert.equal(f.timers.count(), 0);
  f.timers.tick(); assert.equal(emitted, 1);
});

test('authorization is rechecked once per sample even without commits', gate, t => {
  const f = fixture(t); f.write({ id: 1 });
  const stream = f.subscribe(); stream.allowed = false;
  f.timers.tick(); assert.deepEqual(stream.stopped, ['chat_access_revoked']);
  assert.equal(f.timers.count(), 0); assert.equal(stream.events.length, 1);
  let attempts = 0, stopped = 0, emitted = 0;
  f.observer.subscribe({ tab: 'mine', conversationId: idFor('dash:one') }, {
    validate: () => ++attempts === 1, send: () => emitted++, onStop: () => stopped++ });
  assert.equal(attempts, 1); assert.equal(emitted, 1); assert.equal(stopped, 0);
  f.timers.tick(); assert.equal(attempts, 2); assert.equal(emitted, 1);
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
  f.timers.tick(); assert.deepEqual(stream.stopped, ['chat_unavailable', 'chat_database_changed']); assert.equal(f.timers.count(), 0);
  const fresh = f.subscribe({ tab: 'mine', conversationId: idFor('dash:one') });
  assert.equal(fresh.events[0].event, 'chat_ready'); assert.equal(f.reader._generation, 2);
});

test('missing database retains one generation watch and restoration closes each detached stream once', gate, t => {
  const f = fixture(t); f.write({ id: 1 }); const stream = f.subscribe(); f.writer.close();
  fs.renameSync(f.sandbox.paths.c4Db, f.sandbox.paths.c4Db + '.saved');
  f.timers.tick(); assert.equal(stream.stopped[0], 'chat_unavailable'); assert.equal(f.timers.count(), 1);
  const unavailable = f.subscribe(); assert.equal(unavailable.events.length, 0); assert.equal(unavailable.stopped[0], 'chat_unavailable');
  assert.equal(f.observer.subscriptions.size, 0); assert.equal(f.observer.recoveries.size, 2);
  for (let i = 0; i < 25; i++) f.timers.tick();
  assert.deepEqual(stream.stopped, ['chat_unavailable']); assert.deepEqual(unavailable.stopped, ['chat_unavailable']);
  assert.equal(f.timers.count(), 1, 'many missing samples share one loop without ending ordinary streams');
  fs.renameSync(f.sandbox.paths.c4Db + '.saved', f.sandbox.paths.c4Db);
  f.timers.tick();
  for (const item of [stream, unavailable]) assert.deepEqual(item.stopped, ['chat_unavailable', 'chat_database_changed']);
  assert.equal(f.observer.recoveries.size, 0); assert.equal(f.timers.count(), 0);
  const recovered = f.subscribe(); assert.equal(recovered.events[0].event, 'chat_ready');
  fs.renameSync(f.sandbox.paths.c4Db, f.sandbox.paths.c4Db + '.valid');
  fs.writeFileSync(f.sandbox.paths.c4Db, 'corrupt replacement');
  f.timers.tick(); assert.equal(recovered.stopped[0], 'chat_unavailable');
  const corrupt = f.subscribe(); assert.equal(corrupt.events.length, 0); assert.equal(corrupt.stopped[0], 'chat_unavailable');
  f.observer.close(); assert.equal(f.timers.count(), 0); assert.equal(recovered.stopped[0], 'chat_unavailable');
  assert.equal(f.observer.subscriptions.size, 0);
});

// Reader/observer recovery integration. Run when cached reader identity or chat
// demotion changes; rendering-only changes may skip. The gated sandbox proves
// private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DB before access, and owns
// all handles/timers/files. No HTTP, production resources, model, PM2 or tmux.
test('history reopens a restored database after caching an empty replacement without a new subscription', gate, t => {
  const f = fixture(t); f.write({ id: 1, content: 'original stored message' });
  const stream = f.subscribe();
  assert.equal(stream.events[0].event, 'chat_ready');
  f.writer.close();
  const filename = f.sandbox.paths.c4Db, saved = filename + '.saved';
  fs.renameSync(filename, saved);
  f.timers.tick();
  assert.equal(stream.stopped[0], 'chat_unavailable');
  assert.equal(f.reader._db, null, 'observer closes its missing database handle');
  assert.equal(f.observer.subscriptions.size, 0); assert.equal(f.timers.count(), 1);

  const emptyWriter = createDb(filename);
  try { assert.equal(emptyWriter.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0); }
  finally { emptyWriter.close(); }
  assert.equal(f.history.list({ tab: 'mine' }).items.length, 0, 'ordinary history read caches the empty replacement');
  const emptyHandle = f.reader._db, emptyGeneration = f.reader._generation;
  assert.ok(emptyHandle?.open);
  fs.renameSync(saved, filename);

  // No subscribe/readVersion/tick occurs between restoration and this read.
  const restored = f.history.list({ tab: 'mine' });
  assert.equal(restored.items.length, 1, 'list must read restored data instead of the deleted empty file');
  assert.equal(restored.items[0].id, idFor('dash:one'));
  assert.equal(f.history.messages(idFor('dash:one'), { tab: 'mine' }).items[0].content, 'original stored message');
  assert.equal(emptyHandle.open, false, 'cached empty handle is closed');
  assert.equal(f.reader._generation, emptyGeneration + 1, 'existing open path advances generation once');
  assert.equal(f.observer.subscriptions.size, 0); assert.equal(f.timers.count(), 1);
});

// Same isolated real-DB fixture and lifecycle as above. Run for generation-watch
// membership or authorization changes; UI-only work may skip. No HTTP or tmux.
test('detached generation watches never sample history and release their shared loop on revocation or unsubscribe', gate, t => {
  const f = fixture(t); f.write({ id: 1 });
  const first = f.subscribe(), second = f.subscribe();
  let snapshots = 0;
  const snapshot = f.history.chatChangeSnapshot.bind(f.history);
  f.history.chatChangeSnapshot = (...args) => { snapshots++; return snapshot(...args); };
  f.writer.close(); fs.renameSync(f.sandbox.paths.c4Db, f.sandbox.paths.c4Db + '.saved');
  f.timers.tick(); assert.equal(f.observer.recoveries.size, 2);
  for (let i = 0; i < 25; i++) f.timers.tick();
  assert.equal(snapshots, 0, 'detached streams perform only version checks');
  first.allowed = false; f.timers.tick();
  assert.deepEqual(first.stopped, ['chat_unavailable', 'chat_access_revoked']);
  assert.equal(f.observer.recoveries.size, 1); assert.equal(f.timers.count(), 1);
  second.off(); assert.equal(f.observer.recoveries.size, 0); assert.equal(f.timers.count(), 0);
  fs.renameSync(f.sandbox.paths.c4Db + '.saved', f.sandbox.paths.c4Db); f.timers.tick();
  assert.deepEqual(second.stopped, ['chat_unavailable'], 'closed transport has no recovery callback');
});

test('metadata snapshots share history visibility and discover only scoped pending rows', gate, t => {
  const f = fixture(t); f.write({ id: 1 });
  for (const [i, channel] of ['void', 'internal', 'system', 'scheduler', 'control'].entries()) f.write({ id: 10 + i, channel });
  f.write({ id: 20, group: 'origin' }); f.write({ id: 21, group: '*' });
  f.write({ id: 22, group: 'unowned:one' }); f.write({ id: 23, direction: 'other' });
  f.write({ id: 24, channel: 'telegram', group: 'telegram:one' });
  const own = f.history.chatChangeSnapshot({ tab: 'mine', conversationId: idFor('dash:one') }, { afterId: 0 });
  assert.equal(own.listChanged, true); assert.equal(own.latestId, 1); assert.equal(own.highwater, 24);
  const external = f.history.chatChangeSnapshot({ tab: 'external' }, { afterId: 23 }); assert.equal(external.listChanged, true);
  const hiddenOnly = f.history.chatChangeSnapshot({ tab: 'mine' }, { afterId: 1 }); assert.equal(hiddenOnly.listChanged, false);
  assert.throws(() => f.history.chatChangeSnapshot({ tab: 'mine', conversationId: idFor('telegram:one') }), /chat_conversation_not_found/);
  assert.deepEqual(own.delivery.map(row => row.id), [1], 'only selected conversation pending rows are monitored');
  assert.equal(external.delivery.length, 0, 'external chat does not monitor delivery rows');
  f.writer.transaction(() => { for (let i = 100; i < 300; i++) f.write({ id: i, direction: 'out', status: 'delivered' }); })();
  const bounded = f.history.chatChangeSnapshot({ tab: 'mine', conversationId: idFor('dash:one') }, { afterId: 24 });
  assert.equal(bounded.listChanged, true); assert.equal(bounded.highwater, 299); assert.equal(bounded.latestId, 299); assert.equal(bounded.delivery.length, 1);
  const baseline = f.history.chatChangeSnapshot({ tab: 'mine' }); assert.equal(baseline.listChanged, false);
  assert.throws(() => f.history.chatChangeSnapshot({ tab: 'mine' }, { afterId: 300 }), /chat_history_unavailable/);
});

test('chat subscription query contains only explicit conversation scope', () => {
  assert.equal(parseChatSubscription(new URLSearchParams()), null);
  assert.deepEqual(parseChatSubscription(new URLSearchParams('chat=1&chat_tab=mine&chat_conversation=g:646173683A6F6E65')),
    { tab: 'mine', conversationId: 'g:646173683A6F6E65' });
  for (const query of ['chat=0', 'chat=1&chat=1', 'chat=1&chat_tab=other',
    'chat=1&chat_conversation=d:one', 'chat=1&chat_conversation=g:ff',
    'chat=1&chat_conversation=g:FF&chat_conversation=g:EE',
    'chat=1&chat_ids=', 'chat=1&chat_ids=1', 'chat=1&chat_conversation=g:FF&chat_ids=1']) {
    assert.throws(() => parseChatSubscription(new URLSearchParams(query)), error => error.statusCode === 400, query);
  }
});

// Real INSERT windows prove historical excluded rows are never rescanned.
// Run for frontier/scope changes under the same gated private DB lifecycle.
test('incremental list hints survive large excluded tails without leaking hidden-only commits', gate, t => {
  const f = fixture(t); f.write({ id: 1 });
  const stream = f.subscribe({ tab: 'mine', conversationId: null });
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
  const options = { tab: 'mine', conversationId: null };
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
    { tab: 'mine', conversationId: idFor('dash:g1') },
    { tab: 'external', conversationId: null },
  ];
  addRange(1, 100000);
  const outputs = [], listPlans = {}, pendingPlans = {}, baselineMs = {};
  const query = f.history._query.bind(f.history);
  f.history._query = (sql, parameters) => {
    const rows = query(sql, parameters);
    if (sql.includes('c.status=@status') && !pendingPlans[parameters.status]) {
      pendingPlans[parameters.status] = f.reader._db.prepare('EXPLAIN QUERY PLAN ' + sql).all(parameters).map(row => row.detail);
      assert.ok(rows.length <= 100, 'each fixed-status query is bounded');
    }
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
  assert.equal(Object.keys(pendingPlans).length, 2);
  for (const plan of Object.values(pendingPlans)) {
    assert.ok(plan.some(value => value.includes('SEARCH c USING INDEX idx_conv_group_status (session_group=? AND direction=? AND status=?)')));
    assert.equal(plan.some(value => value.includes('TEMP B-TREE')), false, 'fixed-status seek supplies row ID order');
  }
  console.info('chat observer query costs', JSON.stringify({ results: outputs, baselineMs, listPlans, pendingPlans, maxPlan, selectedPlan,
    boundary: 'List uses newly committed ID ranges; pending/running discovery reads at most100 each from the group/status index and retains100 newest. No fixed bound on rows inserted between list samples.' }));
});

// Server-owned pending discovery on a stable subscription: a terminal row
// leaves the bounded snapshot and must still dirty the authoritative status.
test('one conversation stream discovers new pending inputs and observes terminal transitions without client IDs', gate, t => {
  const f = fixture(t); f.write({ id: 1, direction: 'out', status: 'delivered' });
  const stream = f.subscribe({ tab: 'mine', conversationId: idFor('dash:one') });
  assert.equal(stream.events.length, 1); assert.equal(stream.events[0].data.ids.length, 0);
  for (const [index, terminal] of ['delivered', 'failed', 'switch_absorbed'].entries()) {
    const id = index + 2, before = stream.events.length;
    f.write({ id }); f.timers.tick();
    assert.ok(stream.events.length > before);
    assert.equal(stream.events.at(-1).event, 'chat_delivery_changed');
    assert.ok(stream.events.at(-1).data.ids.includes(id));
    f.writer.prepare("UPDATE conversations SET status='running' WHERE id=?").run(id); f.timers.tick();
    assert.equal(stream.events.at(-1).event, 'chat_delivery_changed');
    const pendingEvents = stream.events.length;
    f.writer.prepare('UPDATE conversations SET status=? WHERE id=?').run(terminal, id); f.timers.tick();
    assert.equal(stream.events.length, pendingEvents + 1);
    assert.equal(stream.events.at(-1).event, 'chat_delivery_changed');
    assert.equal(stream.events.at(-1).data.ids.includes(id), false, 'terminal disappearance emits a scope hint');
    assert.equal(f.observer.subscriptions.size, 1, 'no resubscription is needed for sends or delivery transitions');
    assert.equal(f.timers.count(), 1);
  }
  const count = stream.events.length;
  f.write({ id: 20, channel: 'internal', group: 'private:other' }); f.timers.tick();
  assert.equal(stream.events.length, count, 'retiring terminal rows does not create an extra hint');
});

test('server pending discovery retains the newest hundred scoped inbound rows with bounded indexed reads', gate, t => {
  const f = fixture(t);
  f.writer.transaction(() => {
    for (let id = 1; id <= 300; id++) f.write({ id, status: id % 2 ? 'pending' : 'running' });
    for (let id = 301; id <= 350; id++) f.write({ id, group: 'dash:other', endpoint: 'other' });
    for (let id = 351; id <= 400; id++) f.write({ id, direction: 'out', status: 'pending' });
  })();
  const options = { tab: 'mine', conversationId: idFor('dash:one') };
  const snapshot = f.history.chatChangeSnapshot(options);
  assert.equal(snapshot.delivery.length, 100);
  for (let offset = 0; offset < 100; offset++) {
    assert.equal(snapshot.delivery[offset].id, 201 + offset);
    assert.equal(snapshot.delivery[offset].direction, 'in');
  }
  const stream = f.subscribe(options), count = stream.events.length;
  f.writer.prepare("UPDATE conversations SET status='delivered' WHERE id=300").run(); f.timers.tick();
  assert.equal(stream.events.length, count + 1);
  assert.equal(stream.events.at(-1).event, 'chat_delivery_changed');
  assert.equal(stream.events.at(-1).data.ids.length, 100);
  assert.equal(stream.events.at(-1).data.ids.includes(300), false);
  assert.equal(stream.events.at(-1).data.ids.includes(200), true);
  assert.equal(f.reader._db.pragma('query_only', { simple: true }), 1);
});
