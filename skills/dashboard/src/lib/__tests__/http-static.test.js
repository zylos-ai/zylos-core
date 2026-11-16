import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { serveStatic } from '../http.js';

// Exercise the exported handler over HTTP without starting Dashboard services or
// reading installed assets. Every listener and file belongs to this fixture.
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-cache-'));
  const root = path.join(directory, 'dashboard', 'public');
  const files = {
    '/index.html': ['index.html', '<!doctype html><title>Dashboard</title>'],
    '/nested/': ['nested/index.html', '<!doctype html><title>Nested</title>'],
    '/app.js': ['app.js', 'export const version = 1;'],
    '/theme.css': ['theme.css', 'body { color: blue; }'],
    '/font.woff2': ['font.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 255])],
    '/vendor/chart.js': ['../node_modules/chart.js/dist/chart.js', '/* fixture chart */'],
    '/_assets/chat-schema.js': ['../../comm-bridge/scripts/c4-content-schema.js', 'export const schema = 1;'],
  };
  for (const [relative, body] of Object.values(files)) {
    const filename = path.resolve(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, body);
  }
  const server = http.createServer((req, res) => {
    if (!serveStatic(req, res, root)) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  function request(url, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: url, method, headers, agent: false }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(chunks) }));
      });
      req.setTimeout(3000, () => req.destroy(new Error('static request timed out')));
      req.on('error', reject);
      req.end();
    });
  }
  return { root, files, request };
}

for (const url of ['/', '/index.html', '/nested/', '/_assets/index.html']) {
  test(`HTML remains no-store even with a wildcard validator: ${url}`, async t => {
    const { request } = await fixture(t);
    for (const headers of [{}, { 'if-none-match': '*' }]) {
      const response = await request(url, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
      assert.match(response.body.toString(), /<!doctype html>/);
    }
  });
}

const assets = [
  ['/app.js', '/app.js', 'text/javascript; charset=utf-8'],
  ['/_assets/app.js', '/app.js', 'text/javascript; charset=utf-8'],
  ['/theme.css', '/theme.css', 'text/css; charset=utf-8'],
  ['/font.woff2', '/font.woff2', 'font/woff2'],
  ['/vendor/chart.js', '/vendor/chart.js', 'text/javascript; charset=utf-8'],
  ['/_assets/vendor/chart.js', '/vendor/chart.js', 'text/javascript; charset=utf-8'],
  ['/_assets/chat-schema.js', '/_assets/chat-schema.js', 'text/javascript; charset=utf-8'],
];

for (const [url, fileKey, mime] of assets) {
  test(`static asset revalidates with ETag on GET and HEAD: ${url}`, async t => {
    const { files, request } = await fixture(t);
    const initial = await request(url);
    assert.equal(initial.status, 200);
    assert.equal(initial.headers['cache-control'], 'no-cache');
    assert.equal(initial.headers['content-type'], mime);
    assert.deepEqual(initial.body, Buffer.from(files[fileKey][1]));
    const etag = initial.headers.etag;
    assert.match(etag, /^(?:W\/)?"[^\"]+"$/);
    const strong = etag.replace(/^W\//, '');

    const head = await request(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.etag, etag);
    assert.equal(head.headers['cache-control'], 'no-cache');
    assert.equal(head.headers['content-type'], mime);
    assert.equal(head.body.length, 0);

    for (const method of ['GET', 'HEAD']) {
      for (const validator of [strong, `W/${strong}`, `"unrelated", W/${strong}, "later"`, '*']) {
        const response = await request(url, { method, headers: { 'if-none-match': validator } });
        assert.equal(response.status, 304, `${method} ${validator}`);
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.equal(response.headers.etag, etag);
        assert.equal(response.body.length, 0);
      }
      const stale = await request(url, { method, headers: { 'if-none-match': '"stale"' } });
      assert.equal(stale.status, 200);
      assert.equal(stale.headers.etag, etag);
      assert.equal(stale.headers['cache-control'], 'no-cache');
      assert.deepEqual(stale.body, method === 'HEAD' ? Buffer.alloc(0) : initial.body);
    }
  });
}

for (const url of ['/app.js', '/vendor/chart.js', '/_assets/chat-schema.js']) {
  test(`modified static files invalidate an old ETag: ${url}`, async t => {
    const { root, files, request } = await fixture(t);
    const initial = await request(url);
    const filename = path.resolve(root, files[url][0]);
    // Change both bytes and metadata deterministically, without sleeping for the
    // host filesystem's timestamp resolution.
    const originalStat = fs.statSync(filename);
    const body = '/* changed asset with a different size */';
    fs.writeFileSync(filename, body);
    fs.utimesSync(filename, originalStat.atime, new Date(originalStat.mtimeMs + 2000));
    const changed = await request(url, { headers: { 'if-none-match': initial.headers.etag } });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers['cache-control'], 'no-cache');
    assert.notEqual(changed.headers.etag, initial.headers.etag);
    assert.equal(changed.body.toString(), body);
    const revalidated = await request(url, { headers: { 'if-none-match': changed.headers.etag } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0);
  });
}

test('same-size asset edits invalidate a cached body after a one-millisecond modification', async t => {
  const { root, request } = await fixture(t);
  const filename = path.join(root, 'app.js');
  const timestamp = new Date(1700000000000);
  fs.utimesSync(filename, timestamp, timestamp);
  const initial = await request('/app.js');
  const stat = fs.statSync(filename);
  const replacement = Buffer.alloc(initial.body.length, 'x');
  fs.writeFileSync(filename, replacement);
  fs.utimesSync(filename, stat.atime, new Date(stat.mtimeMs + 1));
  assert.equal(fs.statSync(filename).mtimeMs - stat.mtimeMs, 1);
  const changed = await request('/app.js', { headers: { 'if-none-match': initial.headers.etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, initial.headers.etag);
  assert.deepEqual(changed.body, replacement);
});

test('wildcard validators do not turn missing files or forbidden paths into 304', async t => {
  const { request } = await fixture(t);
  for (const [url, expectedStatus] of [['/missing.js', 404],
    ['/_assets/..%2foutside.js', 403], ['/_assets/chat-schema-private.js', 404]]) {
    const response = await request(url, { headers: { 'if-none-match': '*' } });
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.etag, undefined);
  }
});
