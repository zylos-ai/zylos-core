import test from 'node:test';
import assert from 'node:assert/strict';
import { getMaxConversationId } from '../c4-db.js';
import { fixture } from './c4-v2-test-helpers.js';

test('message head includes every status and ignores timestamp ordering', t => {
  const { db } = fixture(t);
  assert.equal(getMaxConversationId(db), 0);
  const insert = db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,timestamp) VALUES(?,'in','telegram','group','body',?,?)");
  insert.run(4, 'delivered', '2026-11-18 00:00:00');
  insert.run(9, 'pending', '2020-01-01 00:00:00');
  insert.run(9007199254740991, 'failed', '2019-01-01 00:00:00');
  assert.equal(getMaxConversationId(db), Number.MAX_SAFE_INTEGER);
});
