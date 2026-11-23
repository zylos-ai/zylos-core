import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isoTimestamp, projectApiTimestamps, projectEventTimestamps } from '../wire-time.js';
import { sendJson } from '../http.js';
import { SseHub } from '../sse.js';

const at = Date.UTC(2026, 10, 16, 2, 3, 4);
const iso = new Date(at).toISOString();

test('explicit time units normalize numeric, SQLite and ISO values without guessing magnitudes', () => {
  assert.equal(isoTimestamp(at), iso);
  assert.equal(isoTimestamp(at / 1000, 's'), iso);
  assert.equal(isoTimestamp(String(at)), iso);
  assert.equal(isoTimestamp(at / 86400000 + 2440587.5, 'julian'), iso);
  assert.equal(isoTimestamp('2026-11-16 02:03:04'), iso);
  assert.equal(isoTimestamp('2026-11-16T10:03:04+08:00'), iso);
  for (const value of [null, undefined, '', 0, '0']) for (const unit of ['ms', 's', 'julian']) assert.equal(isoTimestamp(value, unit), null);
  assert.equal(isoTimestamp(Infinity), null);
  assert.equal(isoTimestamp('unreadable'), null);
});

test('chat, observer, fleet and key projections keep user content and identifiers opaque', () => {
  const chat = { items: [{ id: 1700000000, stamp: at / 86400000 + 2440587.5, timestamp: at,
    quote: { timestamp: at }, content: { timestamp: at, createdAt: at } }], nextCursor: 'opaque' };
  const projected = projectApiTimestamps('/api/conversations', chat);
  assert.equal(projected.items[0].stamp, iso);
  assert.equal(projected.items[0].timestamp, iso);
  assert.equal(projected.items[0].quote.timestamp, iso);
  assert.deepEqual(projected.items[0].content, chat.items[0].content);
  assert.equal(projected.items[0].id, 1700000000);
  assert.equal(projectApiTimestamps('/api/observer/leases', { expiresAt: at }).expiresAt, iso);
  assert.equal(projectApiTimestamps('/api/keys', { items: [{ created_at: '2026-11-16 02:03:04' }], nextCursor: 'opaque' }).items[0].created_at, iso);
  assert.equal(projectApiTimestamps('/api/fleet', { items: [{ rate_limit_7d_recorded_at: at }] }).items[0].rate_limit_7d_recorded_at, iso);
});

test('HTTP and SSE use the same immutable wire projection', () => {
  const data = { readAt: at, running: { total: 1 } };
  const response = { apiPath: '/api/groups/counts', writeHead() {}, end(body) { this.body = JSON.parse(body); } };
  sendJson(response, 200, data);
  assert.equal(response.body.readAt, iso);
  const res = new EventEmitter();
  const chunks = [];
  res.writeHead = () => {};
  res.write = text => { chunks.push(text); return true; };
  res.end = () => {};
  const hub = new SseHub();
  hub.addClient(res);
  hub.broadcast('groups', data);
  hub.closeAll();
  const frame = chunks.find(value => value.includes('event: groups'));
  assert.deepEqual(JSON.parse(frame.match(/data: (.*)/)[1]), response.body);
  assert.equal(data.readAt, at);
  assert.equal(projectEventTimestamps('metric_update', { timestamp: at }).timestamp, iso);
  assert.equal(projectEventTimestamps('metric_update', { dimensions: { rate_limit_7d_resets_at: at / 1000 } }).dimensions.rate_limit_7d_resets_at, iso);
});
