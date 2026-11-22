import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOLEAN, parseListQuery, listErrorBody } from '../list-query.js';

const spec = { filters: { side: ['running', 'offline'], runtimeOverridden: BOOLEAN }, q: true, include: ['total'] };
const parse = (text, options = spec, collection = 'groups') => parseListQuery(collection, new URLSearchParams(text), options);
const rejects = (text, code, param, options) => assert.throws(() => parse(text, options), error => {
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, code);
  assert.equal(error.param, param);
  return true;
});

test('a list query parses filters, q, include and limit with the standard defaults', () => {
  assert.deepEqual({ ...parse(''), nextCursor: undefined },
    { filters: {}, extras: {}, q: null, include: new Set(), limit: 50, after: null, nextCursor: undefined });
  const query = parse('side=running&runtimeOverridden=false&q=%20Work%20&include=total&limit=100');
  assert.deepEqual(query.filters, { side: 'running', runtimeOverridden: false });
  assert.equal(query.q, 'Work');
  assert.deepEqual([...query.include], ['total']);
  assert.equal(query.limit, 100);
  assert.equal(parse('q=%20%20').q, null);
});

test('unknown, repeated and invalid parameters are rejected with their name', () => {
  rejects('offset=10', 'invalid_parameter', 'offset');
  rejects('side=running&side=offline', 'invalid_parameter', 'side');
  rejects('side=stopped', 'invalid_parameter', 'side');
  rejects('runtimeOverridden=1', 'invalid_parameter', 'runtimeOverridden');
  rejects('limit=0', 'invalid_parameter', 'limit');
  rejects('limit=101', 'invalid_parameter', 'limit');
  rejects('limit=05', 'invalid_parameter', 'limit');
  rejects(`q=${'x'.repeat(65)}`, 'invalid_parameter', 'q');
  rejects('include=raw', 'invalid_parameter', 'include');
  rejects('include=total,total', 'invalid_parameter', 'include');
  rejects('limit=8', 'invalid_parameter', 'limit', { include: ['raw'], paging: false });
  let failure;
  try { parse('offset=1'); } catch (error) { failure = error; }
  assert.deepEqual(listErrorBody(failure), { ok: false, error: { code: 'invalid_parameter', message: 'Unknown parameter offset', param: 'offset' } });
});

test('a cursor returns its position only for the same collection, filters and q', () => {
  const cursor = parse('side=running&q=work').nextCursor([1700000000000, 'telegram:a']);
  const text = `q=work&side=running&cursor=${encodeURIComponent(cursor)}`;
  assert.deepEqual(parse(text).after, [1700000000000, 'telegram:a']);
  for (const other of [`side=offline&q=work&cursor=${encodeURIComponent(cursor)}`, `side=running&cursor=${encodeURIComponent(cursor)}`]) {
    rejects(other, 'invalid_cursor', undefined);
  }
  assert.throws(() => parse(text, spec, 'conversations'), { code: 'invalid_cursor' });
  const [body, signature] = cursor.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), position: [0, 'x'] })).toString('base64url');
  rejects(`side=running&q=work&cursor=${forged}.${signature}`, 'invalid_cursor', undefined);
  rejects('cursor=not-a-cursor', 'invalid_cursor', undefined);
});

test('extras are validated but a cursor stays valid when they change', () => {
  const ids = value => /^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(value) ? value.split(',').map(Number) : undefined;
  const timeline = { filters: { tab: ['mine', 'external'] }, extras: { direction: ['before', 'after'], recheckIds: ids } };
  const cursor = parse('tab=mine&direction=before', timeline, 'messages:g:1').nextCursor(41);
  const query = parse(`tab=mine&direction=after&recheckIds=3,7&cursor=${cursor}`, timeline, 'messages:g:1');
  assert.deepEqual(query.extras, { direction: 'after', recheckIds: [3, 7] });
  assert.equal(query.after, 41);
  rejects('recheckIds=3,x', 'invalid_parameter', 'recheckIds', timeline);
});

test('cursors issued before a restart are rejected', async () => {
  const cursor = parse('').nextCursor(['x']);
  const restarted = await import(`../list-query.js?restart=${Date.now()}`);
  assert.throws(() => restarted.parseListQuery('groups', new URLSearchParams({ cursor }), spec), { code: 'invalid_cursor' });
});
