import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { verifyApiKey, verifyCodexApiKey } from '../init-api-auth.js';

const isolation = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]));
const isolationRoot = path.dirname(isolation.TMPDIR || '');
assert.match(path.basename(isolationRoot), /^zylos-tests-/);
for (const value of Object.values(isolation)) assert.ok(value && value.startsWith(isolationRoot + path.sep), 'auth tests require the official isolated runner');
console.log('Init credential isolation:', JSON.stringify({ root: isolationRoot, ...isolation, resources: 'localhost HTTP only; no PM2, tmux or database' }));

// Local transport integration only. Run for URL/header/status/timeout changes.
// No runtime/PM2/tmux/database is opened; the official runner isolates HOME and ZYLOS_DIR.
async function server(t, handle, observeConnection = () => {}) {
  const sockets = new Set();
  const listener = http.createServer(handle);
  listener.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); observeConnection(socket); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => listener.close(resolve));
  });
  return `http://127.0.0.1:${listener.address().port}`;
}

for (const authToken of [false, true]) test(`Claude verification sends only its selected ${authToken ? 'Bearer' : 'API key'} header to the exact base prefix`, { timeout: 3000 }, async t => {
  const credential = crypto.randomUUID(); let requests = 0;
  const baseUrl = await server(t, (req, res) => {
    requests += 1;
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/relay/v1/models');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(authToken ? req.headers.authorization === `Bearer ${credential}` : req.headers['x-api-key'] === credential, true);
    assert.equal(authToken ? req.headers['x-api-key'] === undefined : req.headers.authorization === undefined, true);
    req.on('data', () => assert.fail('Claude models verification sent a request body'));
    req.on('end', () => { res.writeHead(200); res.end(); });
  });
  assert.equal(await verifyApiKey(credential, { baseUrl: baseUrl + '/relay/', authToken }), true);
  assert.equal(requests, 1);
});


test('redirects are inconclusive and never forward the credential to another listener', { timeout: 3000 }, async t => {
  let forwarded = 0;
  const target = await server(t, (req, res) => { forwarded += 1; res.end(); });
  const origin = await server(t, (req, res) => { res.writeHead(307, { location: target }); res.end(); });
  assert.equal(await verifyApiKey(crypto.randomUUID(), { baseUrl: origin }), null);
  assert.equal(await verifyCodexApiKey(crypto.randomUUID(), { baseUrl: origin }), null);
  assert.equal(forwarded, 0);
});
