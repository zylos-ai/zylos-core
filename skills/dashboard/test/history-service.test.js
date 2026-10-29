import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BroadcastChannel } from 'node:worker_threads';
import { createRedactor, UNAVAILABLE } from '../src/lib/redaction/engine.js';
import { HistoryService, textChunk } from '../src/lib/history/history-service.js';
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
  const server = http.createServer((req, res) => service.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/observer/history/${suffix}`, { method, headers });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body, json: () => JSON.parse(body) };
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('all textual public paths redact decoded strings before previews, totals and searches', async () => {
  const { service } = fixture([{ id: 'o:0', kind: 'tool', name: secret, channel: secret, fields: { input: { password: secret, nested: ['line\n' + secret] }, output: secret + 'a'.repeat(3000) } }]);
  const listing = await service.sessions();
  assert.equal(listing.sessions[0].title, '[redacted]');
  assert.ok(!JSON.stringify(listing).includes('privatePath'));
  const result = await service.entries(params());
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.entries[0].fields.output.total, 3010);
  assert.equal(result.entries[0].fields.output.truncated, true);
  assert.equal(result.entries[0].redaction.count, 5);
  const full = await service.content(params({ entry: 'o:0', field: 'input' }));
  assert.deepEqual(JSON.parse(full.text), { password: '[redacted]', nested: ['line\n[redacted]'] });
  assert.deepEqual((await service.search(params({ q: secret }))).matches, []);
  assert.equal((await service.search(params({ q: 'redacted' }))).matches.length, 1);
});

test('content chunks reassemble redacted whole text, including a secret across byte boundary and Unicode', async () => {
  const original = 'a'.repeat(262140) + secret + '😀中文'.repeat(90000);
  const { service } = fixture([{ id: 'o:0', kind: 'text', fields: { body: original } }]);
  let offset = 0, rebuilt = '', loops = 0;
  do {
    const part = await service.content(params({ entry: 'o:0', field: 'body', offset: String(offset) }));
    assert.ok(Buffer.byteLength(part.text) <= 256 * 1024);
    assert.ok(!part.text.includes(secret));
    rebuilt += part.text; offset = part.next; loops++;
  } while (offset !== null);
  assert.equal(rebuilt, original.replaceAll(secret, '[redacted]'));
  assert.ok(loops >= 3);
  assert.throws(() => textChunk('😀', 1), /invalid_offset/);
});

test('stable pagination, around, internal filtering, append and old tool updates', async () => {
  const entries = [
    { id: 'o:0', kind: 'text', fields: { body: 'first' } },
    { id: 'o:10', kind: 'tool', status: 'running', fields: { input: 'cmd' } },
    { id: 'o:20', kind: 'internal', fields: { raw: { developer: secret } } },
    { id: 'o:30', kind: 'text', fields: { body: 'last' } },
  ];
  const { service } = fixture(entries);
  assert.deepEqual((await service.entries(params({ limit: '2' }))).entries.map((e) => e.id), ['o:10', 'o:30']);
  assert.deepEqual((await service.entries(params({ before: 'o:30', limit: '2' }))).entries.map((e) => e.id), ['o:0', 'o:10']);
  assert.deepEqual((await service.entries(params({ around: 'o:10', limit: '3' }))).entries.map((e) => e.id), ['o:0', 'o:10', 'o:30']);
  assert.equal((await service.entries(params({ internal: '1' }))).entries.length, 4);
  entries[1].status = 'success'; entries[1].updatedOffset = 40; entries[1].fields.output = 'done';
  entries.push({ id: 'o:40', kind: 'internal', fields: { raw: 'tool result' } });
  const poll = await service.entries(params({ after: 'o:30' }));
  assert.equal(poll.entries.length, 0); assert.equal(poll.updates[0].status, 'success'); assert.equal(poll.after, 'o:40');
  await assert.rejects(service.entries(params({ before: 'o:1' })), /invalid_cursor/);
  await assert.rejects(service.entries(params({ before: 'o:0', after: 'o:10' })), /invalid_parameters/);
});

test('search continues backwards with stable cursors and sees full text beyond preview', async () => {
  const { service } = fixture([0, 10, 20].map((n) => ({ id: 'o:' + n, kind: 'text', fields: { body: 'a'.repeat(3000) + 'NEEDLE' } })));
  const result = await service.search(params({ q: 'needle', limit: '2' }));
  assert.deepEqual(result.matches.map((m) => m.entry), ['o:20', 'o:10']);
  assert.equal(result.hasMore, true);
  const older = await service.search(params({ q: 'needle', before: result.before }));
  assert.deepEqual(older.matches.map((m) => m.entry), ['o:0']);
  assert.equal(older.hasMore, false);
});

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
  const observer = new ObserverService({ historyService,
    coordinator: { historyStatus: async () => ({ state: 'installed', desired: { enabled: true } }), reconcileStartup: forbidden },
    containment: { reconcilePersisted: forbidden }, manager: { createLease: forbidden },
    authGate: { enabled: true, resolveAuthContext: (req) => req.headers.authorization === 'Bearer admin' ? { kind: 'api', scope: 'admin' } : req.headers.cookie ? { kind: 'cookie', scope: 'admin' } : req.headers.authorization ? { kind: 'api', scope: 'read' } : null },
  });
  for (const [headers, expected] of [[{}, 401], [{ authorization: 'Bearer read' }, 403], [{ authorization: 'Bearer admin' }, 200], [{ cookie: 'session=yes' }, 200]]) {
    assert.equal((await request(observer, 'sessions', { headers })).status, expected);
  }
  assert.equal((await request(observer, 'sessions', { method: 'POST', headers: { authorization: 'Bearer admin' } })).status, 405);
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
    for (const route of ['sessions', 'entries?session=session&internal=1', 'content?session=session&entry=o:0&field=input', 'content?session=session&entry=o:100&field=raw', 'search?session=session&q=synthetic_sensitive_fixture']) {
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

test('session title truncation occurs only after redaction, and expanded records disclose all fields', async () => {
  const fake = 'zylos_st_' + 'B'.repeat(100);
  const { parser } = fixture([{ id: 'o:0', kind: 'marker', deferred: true, fields: { body: 'Oversized record' } }]);
  parser.listSessions = async () => ({ current: 'session', sessions: [{ id: 'session', title: 'a'.repeat(100) + ' ' + fake }] });
  parser.expandEntry = async () => ({ id: 'o:0', kind: 'internal', fields: { body: { note: fake } }, binaries: { attachment_0: { data: Buffer.from('PNG'), mimeType: 'image/png' } } });
  const service = new HistoryService({ parser });
  try {
    const listing = await service.sessions();
    assert.ok(!listing.sessions[0].title.includes('zylos_st_B'));
    const result = await service.content(params({ entry: 'o:0', field: 'body' }));
    assert.ok(!result.text.includes(fake));
    assert.equal(result.expandedEntry.fields.attachment_0.type, 'binary');
    assert.equal((await service.content(params({ entry: 'o:0', field: 'attachment_0' }))).binary.data.toString(), 'PNG');
  } finally { await service.close(); }
});

test('negative control: bypassing service redaction exposes every protected textual path', async () => {
  const fake = 'zylos_st_negative_control_fixture';
  const { parser } = fixture([{ id: 'o:0', kind: 'tool', name: fake, fields: { input: { password: fake }, output: fake } }, { id: 'o:10', kind: 'internal', fields: { raw: { nested: fake } } }]);
  parser.listSessions = async () => ({ current: 'session', sessions: [{ id: 'session', title: fake }] });
  const live = new HistoryService({ parser });
  const mutant = new HistoryService({ parser });
  mutant.safe = async value => ({ text: typeof value === 'string' ? value : JSON.stringify(value), count: 0, kinds: [] });
  try {
    for (const route of ['sessions', 'entries?session=session&internal=1', 'content?session=session&entry=o:0&field=input', 'content?session=session&entry=o:10&field=raw', 'search?session=session&q=negative_control_fixture']) {
      assert.equal((await request(live, route)).body.includes(fake), false, route);
      assert.equal((await request(mutant, route)).body.includes(fake), true, 'redaction acceptance must reject bypass on ' + route);
    }
  } finally { await live.close(); await mutant.close(); }
});

test('HTTP remains available while a small history field stalls its redaction worker', async () => {
  const channelName = `history-stall-${process.pid}-${Date.now()}`;
  const channel = new BroadcastChannel(channelName);
  let signal;
  const started = new Promise(resolve => { signal = resolve; });
  channel.onmessage = () => signal();
  const engineURL = new URL('../src/lib/redaction/engine.js', import.meta.url).href;
  const workerURL = new URL('data:text/javascript,' + encodeURIComponent(`
    import { parentPort, BroadcastChannel } from 'node:worker_threads';
    import { redact } from ${JSON.stringify(engineURL)};
    parentPort.on('message', ({ id, text, options }) => {
      if (text === 'hang') {
        new BroadcastChannel(${JSON.stringify(channelName)}).postMessage('started');
        while (true) {}
      }
      parentPort.postMessage({ id, result: redact(text, options) });
    });
  `));
  const productionRedactor = createRedactor({ workerURL, timeoutMs: 1000 });
  const { parser } = fixture([{ id: 'o:0', kind: 'text', fields: { body: 'hang' } }]);
  const service = new HistoryService({ parser, redactor: productionRedactor });
  const observer = new ObserverService({ historyService: service,
    containment: {}, manager: {},
    coordinator: { historyStatus: async () => ({ state: 'installed', desired: { enabled: true } }) },
    authGate: { enabled: true, resolveAuthContext: () => ({ kind: 'api', scope: 'admin' }) },
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.end('healthy'); return; }
    observer.handle(req, res, new URL(req.url, 'http://localhost'));
  });
  let deadline;
  try {
    assert.equal((await productionRedactor.redact('warm')).text, 'warm');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let historyFinished = false;
    const history = fetch(base + '/api/observer/history/content?session=session&entry=o:0&field=body')
      .then(async response => { historyFinished = true; return { status: response.status, body: await response.json() }; });
    await Promise.race([started, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('worker never entered stall')), 2000); })]);
    clearTimeout(deadline);
    const health = await fetch(base + '/health', { signal: AbortSignal.timeout(500) });
    assert.equal(await health.text(), 'healthy');
    assert.equal(historyFinished, false, 'unrelated HTTP request completes while history scan is pending');
    const result = await history;
    assert.equal(result.status, 200);
    assert.equal(result.body.text, UNAVAILABLE);
    assert.equal((await productionRedactor.redact('password=private-fixture-value')).count, 1);
  } finally {
    clearTimeout(deadline);
    channel.close();
    await service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
