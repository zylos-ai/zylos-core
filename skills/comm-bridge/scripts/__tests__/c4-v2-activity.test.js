import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';

test('last activity uses two primary-key reads and follows head id despite backwards timestamps', t => {
  const trace = [], db = new Database(':memory:', { verbose: sql => trace.push(sql) });
  t.after(() => db.close()); guardDatabase(db, owner);
  const s = createStore(db, { validateComponent: () => true });
  const earlier = s.insertConversation('in', 'foo', 'endpoint', 'first');
  const later = s.insertConversation('in', 'foo', 'endpoint', 'second');
  db.prepare('UPDATE conversations SET timestamp=? WHERE id=?').run('2026-10-23 12:00:00', earlier.id);
  db.prepare('UPDATE conversations SET timestamp=? WHERE id=?').run('2026-10-22 12:00:00', later.id);
  trace.length = 0;
  assert.deepEqual(s.getLastActivity('foo'), { id: later.id, ts: '2026-10-22 12:00:00' });
  assert.equal(trace.length, 2);
  assert.match(trace[0], /^SELECT head_id FROM group_heads WHERE session_group=/);
  assert.match(trace[1], /^SELECT id,timestamp AS ts FROM conversations WHERE id=/);
  // Calibrate the result oracle against the tempting MAX(timestamp) mutant.
  const bad = db.prepare('SELECT id,timestamp AS ts FROM conversations WHERE session_group=? ORDER BY timestamp DESC LIMIT 1').get('foo');
  assert.notDeepEqual(bad, { id: later.id, ts: '2026-10-22 12:00:00' });
  assert.equal(bad.id, earlier.id);
  trace.length = 0; assert.equal(s.getLastActivity('absent'), null); assert.equal(trace.length, 1);
});
