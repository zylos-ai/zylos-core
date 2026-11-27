import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PENDING_MAX_AGE_SECONDS } from '../c4-config.js';
import { formatConversation } from '../router/format.js';

test('live formatting prefixes the queue notice only after the threshold', () => {
  const timestamp = '2026-11-21 02:02:00';
  const received = Date.parse('2026-11-21T02:02:00Z');
  const row = { id: 1, direction: 'in', channel: 'system', timestamp, content: 'Original message' };
  const deadline = received + PENDING_MAX_AGE_SECONDS * 1000;
  assert.equal(formatConversation(row, { now: deadline }), row.content);

  const delayed = formatConversation(row, { now: deadline + 1 });
  const newline = delayed.indexOf('\n');
  assert.match(delayed.slice(0, newline), /^\[C4\] This message waited in the queue for .+ \(received .+\)\. Check whether it still applies before acting on it\.$/);
  assert.equal(delayed.slice(newline + 1), row.content);
});
