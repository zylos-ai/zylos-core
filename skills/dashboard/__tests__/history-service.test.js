import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { HistoryService } from '../src/lib/history/history-service.js';
import { ObserverService } from '../src/lib/observer-service.js';

const secret = 'fixture-private-value';
const redactor = {
  async redact(text) { const count = text.split(secret).length - 1; return { text: text.replaceAll(secret, '[redacted]'), count, kinds: count ? ['fixture'] : [] }; },
  async redactValue(value) {
    let count = 0;
    const walk = async (v) => {
      if (typeof v === 'string') { const result = await this.redact(v); count += result.count; return result.text; }
      if (Array.isArray(v)) return Promise.all(v.map(walk));
      if (v && typeof v === 'object') { const out = {}; for (const [key, item] of Object.entries(v)) out[(await this.redact(key)).text] = await walk(item); return out; }
      return v;
    };
    return { value: await walk(value), count, kinds: count ? ['fixture'] : [] };
  },
};

function fixture(entries) {
  const parser = {
    async listSessions() { return { runtime: 'claude', current: 'session', sessions: [{ id: 'session', title: secret, bytes: 900, privatePath: '/must-not-leak' }] }; },
    async loadSession() { return { entries, index: { lines: entries.map((entry) => ({ offset: Number(entry.id.split(':')[1]) })) }, generation: 1 }; },
  };
  const service = new HistoryService({ parser, redactor });
  return { service, parser };
}
const params = (value) => new URLSearchParams({ session: 'session', ...value });

async function request(service, suffix, { method = 'GET', headers = {} } = {}) {
  const server = http.createServer((req, res) => { const url = new URL(req.url, 'http://localhost'); res.apiPath = url.pathname; return service.handle(req, res, url); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/observer/history/${suffix}`, { method, headers });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body, json: () => JSON.parse(body) };
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('redaction failure closes every text path and never reflects exception messages', async () => {
  const { service } = fixture([{ id: 'o:0', kind: 'text', fields: { body: secret } }]);
  service.redactor = { redact: async () => { throw new Error(secret); } };
  assert.ok(!JSON.stringify(await service.entries(params())).includes(secret));
  assert.equal((await service.content(params({ entry: 'o:0', field: 'body' }))).text, '此内容暂时无法安全显示');
  service.parser.loadSession = async () => { throw new Error(secret); };
  const response = await request(service, 'entries?session=session');
  assert.equal(response.status, 503); assert.equal(response.body.includes(secret), false);
});

test('binary policy: inline raster only, other media download, no-store and sandbox', async () => {
  const entry = { id: 'o:0', kind: 'inbound', fields: {}, binaries: { image: { data: Buffer.from('PNG'), mimeType: 'image/png' }, svg: { data: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' } } };
  const { service } = fixture([entry]);
  for (const [field, disposition] of [['image', 'inline'], ['svg', 'attachment']]) {
    const response = await request(service, `content?session=session&entry=o:0&field=${field}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-security-policy'), 'sandbox');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('content-disposition').startsWith(disposition));
  }
  assert.equal((await request(service, 'content?session=session&entry=o:0&field=__proto__')).status, 404);
});

test('Observer auth protects all history routes without touching containment or leases', async () => {
  const { service: historyService } = fixture([]);
  const forbidden = () => { throw new Error('terminal state touched'); };
  // Admin keys stand for any admin caller here; remote access is on.
  const observer = new ObserverService({ config: { chat: { allowRemote: true } }, historyService,
    coordinator: { historyStatus: async () => ({ state: 'installed', desired: { enabled: true } }), reconcileStartup: forbidden },
    containment: { reconcilePersisted: forbidden }, manager: { createLease: forbidden },
    authGate: { enabled: true, resolveAuthContext: (req) => req.headers.authorization === 'Bearer admin' ? { kind: 'api', scope: 'admin' } : req.headers.cookie ? { kind: 'cookie', scope: 'admin' } : req.headers.authorization ? { kind: 'api', scope: 'read' } : null },
  });
  for (const [headers, expected] of [[{}, 401], [{ authorization: 'Bearer read' }, 403], [{ authorization: 'Bearer admin' }, 200], [{ cookie: 'session=yes' }, 200]]) {
    assert.equal((await request(observer, 'sessions', { headers })).status, expected);
  }
  assert.equal((await request(observer, 'sessions', { method: 'POST', headers: { authorization: 'Bearer admin' } })).status, 404);
  assert.equal((await request(observer, 'unknown', { headers: { authorization: 'Bearer admin' } })).status, 404);
  observer.coordinator.historyStatus = async () => ({ state: 'installed', desired: { enabled: false } });
  assert.equal((await request(observer, 'sessions', { headers: { authorization: 'Bearer admin' } })).status, 404);
});

test('production redactor protects HTTP sessions, metadata, previews, content, internal JSON and search', async () => {
  const fake = 'zylos_st_synthetic_sensitive_fixture_abcdefghijk';
  const { parser } = fixture([
    { id: 'o:0', kind: 'tool', name: fake, fields: { input: { read_api_key: fake, password: 'secret-password-fixture' }, output: 'a'.repeat(262140) + fake + 'z'.repeat(200) } },
    { id: 'o:100', kind: 'internal', fields: { raw: { Cookie: 'session=secret-cookie-fixture', nested: { note: fake } } } },
  ]);
  parser.listSessions = async () => ({ current: 'session', sessions: [{ id: 'session', title: fake }] });
  const service = new HistoryService({ parser });
  try {
    for (const route of ['sessions', 'entries?session=session&internal=true', 'content?session=session&entry=o:0&field=input', 'content?session=session&entry=o:100&field=raw', 'search?session=session&q=synthetic_sensitive_fixture']) {
      const response = await request(service, route);
      assert.equal(response.status, 200, route);
      assert.ok(!response.body.includes(fake), route);
      assert.ok(!response.body.includes('secret-password-fixture'), route);
      assert.ok(!response.body.includes('secret-cookie-fixture'), route);
      assert.ok(!/\b(?:zylos_st_[A-Za-z0-9_-]+|read_api_key|read_session_token)\b/i.test(response.body), route);
    }
    assert.equal((await service.search(params({ q: 'synthetic_sensitive_fixture' }))).matches.length, 0);
    let offset = 0, full = '';
    do {
      const chunk = await service.content(params({ entry: 'o:0', field: 'output', offset: String(offset) }));
      full += chunk.text; offset = chunk.next;
    } while (offset !== null);
    assert.ok(!full.includes(fake)); assert.match(full, /已遮蔽/);
  } finally { await service.close(); }
});
