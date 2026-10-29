import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { serveStatic } from '../src/lib/http.js';

const root = path.resolve('public');

function response() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.body = () => Buffer.concat(chunks).toString('utf8');
  return res;
}

for (const url of ['/%', '/%2', '/%GG', '/%E0%A4', '/%FF', '/_assets/js/%', 'http://[invalid/']) {
  test(`static handler returns handled public 400 for invalid URI ${url}`, async () => {
    const res = response();
    assert.equal(serveStatic({ url }, res, root), true);
    await finished(res);
    assert.equal(res.status, 400);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(res.body()), { error: 'invalid_request' });
  });
}

for (const url of ['/js/gauge-utils.js', '/_assets/js/gauge-utils.js', '/js/%67auge-utils.js', '/js/gauge-utils.js?unused=%']) {
  test(`static handler still serves valid asset ${url}`, async () => {
    const res = response();
    assert.equal(serveStatic({ url }, res, root), true);
    await finished(res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.body(), fs.readFileSync(path.join(root, 'js/gauge-utils.js'), 'utf8'));
  });
}

test('static handler leaves missing file to caller', () => {
  const res = response();
  assert.equal(serveStatic({ url: '/missing-%25-file.js' }, res, root), false);
  assert.equal(res.status, undefined);
  assert.equal(res.writableEnded, false);
  assert.equal(res.body(), '');
});

test('static handler preserves traversal rejection', async () => {
  const res = response();
  assert.equal(serveStatic({ url: '/_assets/..%2fpackage.json' }, res, root), true);
  await finished(res);
  assert.equal(res.status, 403);
  assert.equal(res.body(), 'forbidden');
});
