import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { classifyApiVerification, isOfficialClaudeBaseUrl, isOfficialClaudeVerificationBaseUrl, verifyApiKey, verifyCodexApiKey } from '../init-api-auth.js';

const isolation = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]));
const isolationRoot = path.dirname(isolation.TMPDIR || '');
assert.match(path.basename(isolationRoot), /^zylos-tests-/);
for (const value of Object.values(isolation)) assert.ok(value && value.startsWith(isolationRoot + path.sep), 'auth tests require the official isolated runner');
console.log('Init credential isolation:', JSON.stringify({ root: isolationRoot, ...isolation, resources: 'localhost HTTP only; no PM2, tmux or database' }));

// Local transport integration only. Run for URL/header/status/timeout changes.
// No runtime/PM2/tmux/database is opened; the official runner isolates HOME and ZYLOS_DIR.
async function server(t, handle) {
  const sockets = new Set();
  const listener = http.createServer(handle);
  listener.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => listener.close(resolve));
  });
  return `http://127.0.0.1:${listener.address().port}`;
}

test('verification distinguishes auth rejection, successful proof and inconclusive responses', () => {
  for (const status of [200, 201, 204, 299]) assert.equal(classifyApiVerification(status), true);
  for (const status of [401, 403]) assert.equal(classifyApiVerification(status), false);
  for (const status of [301, 307, 400, 404, 429, 500, 503]) assert.equal(classifyApiVerification(status), null);
  assert.equal(classifyApiVerification(400, { officialAnthropic: true }), true);
  assert.equal(isOfficialClaudeBaseUrl(), true);
  assert.equal(isOfficialClaudeBaseUrl('https://api.anthropic.com/'), true);
  assert.equal(isOfficialClaudeBaseUrl('https://api.anthropic.com.example/'), false);
  assert.equal(isOfficialClaudeVerificationBaseUrl('https://api.anthropic.com/prefix'), true);
  assert.equal(isOfficialClaudeVerificationBaseUrl('http://api.anthropic.com'), false);
  assert.equal(isOfficialClaudeVerificationBaseUrl('https://api.anthropic.com:444'), false);
});

for (const authToken of [false, true]) test(`Claude verification sends only its selected ${authToken ? 'Bearer' : 'API key'} header to the exact base prefix`, { timeout: 3000 }, async t => {
  const credential = crypto.randomUUID(); let requests = 0;
  const baseUrl = await server(t, (req, res) => {
    requests += 1;
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/relay/v1/messages');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(authToken ? req.headers.authorization === `Bearer ${credential}` : req.headers['x-api-key'] === credential, true);
    assert.equal(authToken ? req.headers['x-api-key'] === undefined : req.headers.authorization === undefined, true);
    let body = ''; req.on('data', chunk => { body += chunk; assert.ok(body.length <= 2); });
    req.on('end', () => { assert.equal(body, '{}'); res.writeHead(200); res.end(); });
  });
  assert.equal(await verifyApiKey(credential, { baseUrl: baseUrl + '/relay/', authToken }), true);
  assert.equal(requests, 1);
});

test('Claude base joining preserves an explicit version path exactly like the SDK', { timeout: 3000 }, async t => {
  const baseUrl = await server(t, (req, res) => { assert.equal(req.url, '/prefix/v1/v1/messages'); res.writeHead(400); res.end(); });
  assert.equal(await verifyApiKey(crypto.randomUUID(), { baseUrl: baseUrl + '/prefix/v1' }), null);
});


test('Claude URL joining retains multiple trailing slashes in the configured prefix', { timeout: 3000 }, async t => {
  const baseUrl = await server(t, (req, res) => { assert.equal(req.url, '/prefix//v1/messages'); res.writeHead(200); res.end(); });
  assert.equal(await verifyApiKey(crypto.randomUUID(), { baseUrl: baseUrl + '/prefix//' }), true);
});

test('Codex verification uses the custom versioned base and Bearer without an Anthropic header', { timeout: 3000 }, async t => {
  const credential = crypto.randomUUID(); let requests = 0;
  const baseUrl = await server(t, (req, res) => {
    requests += 1; assert.equal(req.url, '/relay/v1/models'); assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization === `Bearer ${credential}`, true); assert.equal(req.headers['x-api-key'], undefined);
    res.writeHead(204); res.end();
  });
  assert.equal(await verifyCodexApiKey(credential, { baseUrl: baseUrl + '/relay/v1/' }), true);
  assert.equal(requests, 1);
});

for (const status of [400, 401, 403, 404, 429, 503]) test(`custom verification classifies HTTP ${status} without printing response content`, { timeout: 3000 }, async t => {
  const credential = crypto.randomUUID();
  const baseUrl = await server(t, (req, res) => { res.writeHead(status); res.end(credential); });
  assert.equal(await verifyApiKey(credential, { baseUrl }), status === 401 || status === 403 ? false : null);
});

test('redirects are inconclusive and never forward the credential to another listener', { timeout: 3000 }, async t => {
  let forwarded = 0;
  const target = await server(t, (req, res) => { forwarded += 1; res.end(); });
  const origin = await server(t, (req, res) => { res.writeHead(307, { location: target }); res.end(); });
  assert.equal(await verifyApiKey(crypto.randomUUID(), { baseUrl: origin }), null);
  assert.equal(await verifyCodexApiKey(crypto.randomUUID(), { baseUrl: origin }), null);
  assert.equal(forwarded, 0);
});

test('unreachable hosts and absolute timeout are inconclusive and release their sockets', { timeout: 3000 }, async t => {
  const hanging = await server(t, () => {});
  assert.equal(await verifyApiKey(crypto.randomUUID(), { baseUrl: hanging, timeoutMs: 30 }), null);
  assert.equal(await verifyCodexApiKey(crypto.randomUUID(), { baseUrl: hanging, timeoutMs: 30 }), null);
  const listener = http.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const closed = `http://127.0.0.1:${listener.address().port}`; await new Promise(resolve => listener.close(resolve));
  assert.equal(await verifyApiKey(crypto.randomUUID(), { baseUrl: closed }), null);
});

test('malformed or credential-bearing base URLs fail without requests or secret-bearing errors', { timeout: 3000 }, async t => {
  let requests = 0;
  const origin = await server(t, (req, res) => { requests += 1; res.end(); });
  for (const baseUrl of ['not-url', origin.replace('http:', 'ftp:'), origin.replace('http://', 'http://user:password@'), origin + '?q=value', origin + '#fragment', origin + '?', origin + '#']) {
    assert.equal(await verifyApiKey(crypto.randomUUID(), { baseUrl }), null);
    assert.equal(await verifyCodexApiKey(crypto.randomUUID(), { baseUrl }), null);
  }
  assert.equal(requests, 0);
});
