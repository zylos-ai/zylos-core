import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  DIRECT_GITHUB, DEFAULT_TTL_MS, parseUpstreamArgs, resolveSelection, validateProfile,
  prepareUpstreams, setUpstreamSource, clearUpstreamSource, withUpstreamSnapshot, getUpstreamSnapshot,
  githubUrl, upstreamStatus,
} from '../upstreams.js';

const profile = (revision = 'r1', github = { apiBase: 'https://mirror.test/api/', rawBase: 'https://mirror.test/raw/', downloadBase: 'https://mirror.test/download/' }) => ({ schemaVersion: 1, revision, providers: { github } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upstreams-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { zylosDir: dir, env: {} };
  const settings = path.join(dir, '.zylos/upstreams.json');
  const cache = path.join(dir, '.zylos/upstreams-cache.json');
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  return { dir, opts, settings, cache, write };
}
async function remote(t) {
  const f = fixture(t), requests = [];
  let handler = (_req, res) => { res.setHeader('ETag', 'v1'); res.end(JSON.stringify(profile())); };
  const server = http.createServer((req, res) => { requests.push({ path: req.url, headers: req.headers }); handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/config?variant=cn`;
  return { ...f, requests, url, opts: { ...f.opts, allowHttp: true, source: { type: 'remote', url } }, setHandler(fn) { handler = fn; } };
}

test('fresh direct selection is diskless and matches legacy URLs', async t => {
  const f = fixture(t), prepared = await prepareUpstreams(f.opts);
  assert.deepEqual(prepared.snapshot.github, DIRECT_GITHUB);
  assert.equal(fs.existsSync(path.join(f.dir, '.zylos')), false);
  assert.equal(githubUrl('tags', 'zylos-ai/zylos-core'), 'https://api.github.com/repos/zylos-ai/zylos-core/tags?per_page=100');
  assert.equal(githubUrl('raw', 'org/repo', { ref: 'main', path: 'dir/file.md' }), 'https://raw.githubusercontent.com/org/repo/main/dir/file.md');
  assert.equal(githubUrl('archive', 'org/repo', { ref: 'v1.0.0', refType: 'tag' }), 'https://github.com/org/repo/archive/refs/tags/v1.0.0.tar.gz');
});
test('one source flag accepts direct, HTTPS URL and local paths in both forms', () => {
  for (const [value, source] of [
    ['direct', { type: 'direct' }],
    ['https://config.test/p.json?q=1', { type: 'remote', url: 'https://config.test/p.json?q=1' }],
    ['./direct', { type: 'local', path: path.resolve('./direct') }],
    ['./config/profile.json', { type: 'local', path: path.resolve('./config/profile.json') }],
  ]) {
    for (const input of [['--upstream-config', value], [`--upstream-config=${value}`]]) {
      assert.deepEqual(parseUpstreamArgs(['a', ...input, '--yes']), { args: ['a', '--yes'], source });
    }
  }
  for (const args of [['--upstream-config'], ['--upstream-config', '--yes'], ['--upstream-config='], ['--upstream-config', 'direct', '--upstream-config=direct'], ['--upstream-profile', 'direct'], ['--upstream-config-url=https://config.test/p']]) assert.throws(() => parseUpstreamArgs(args));
});
test('selection precedence is CLI > env > saved > default without lower-layer mixing', t => {
  const f = fixture(t);
  f.write(f.settings, { schemaVersion: 1, source: { type: 'remote', url: 'https://saved.test/profile' } });
  assert.equal(resolveSelection(f.opts).url, 'https://saved.test/profile');
  assert.equal(resolveSelection({ ...f.opts, env: { ZYLOS_UPSTREAM_CONFIG: 'https://env.test/profile' } }).url, 'https://env.test/profile');
  assert.equal(resolveSelection({ ...f.opts, env: { ZYLOS_UPSTREAM_CONFIG: 'http://invalid.test' }, source: { type: 'direct' } }).source.type, 'direct');
  assert.equal(resolveSelection({ ...f.opts, env: { ZYLOS_UPSTREAM_CONFIG: 'direct' } }).source.type, 'direct');
  assert.deepEqual(resolveSelection({ ...f.opts, env: { ZYLOS_UPSTREAM_CONFIG: './direct' } }).source, { type: 'local', path: path.resolve('./direct') });
  assert.equal(resolveSelection({ ...f.opts, env: { ZYLOS_UPSTREAM_API_BASE: 'https://ignored.test/' } }).url, 'https://saved.test/profile');
});
test('removed environment selectors fail explicitly even beside a current selector', t => {
  const f = fixture(t);
  for (const name of ['ZYLOS_UPSTREAM_PROFILE', 'ZYLOS_UPSTREAM_CONFIG_URL']) {
    for (const value of ['', 'direct', 'https://config.test/profile']) {
      assert.throws(() => resolveSelection({ ...f.opts, env: { [name]: value } }), /has been removed; use ZYLOS_UPSTREAM_CONFIG/);
      assert.throws(() => resolveSelection({ ...f.opts, source: { type: 'direct' }, env: { [name]: value, ZYLOS_UPSTREAM_CONFIG: 'direct' } }), /has been removed/);
    }
  }
});
test('invalid URL-shaped sources fail for CLI and environment instead of becoming files', t => {
  const f = fixture(t);
  for (const value of ['http://config.test/p', 'ftp://config.test/p', 'file:///tmp/p', 'https:', 'https://', '//config.test/p', 'https://user:pass@config.test/p', 'https://config.test/p#fragment']) {
    assert.throws(() => resolveSelection({ ...f.opts, source: parseUpstreamArgs(['--upstream-config', value]).source }));
    assert.throws(() => resolveSelection({ ...f.opts, env: { ZYLOS_UPSTREAM_CONFIG: value } }));
  }
  assert.throws(() => resolveSelection({ ...f.opts, env: { ZYLOS_UPSTREAM_CONFIG: '' } }), /requires a value/);
});
test('schema and local trust reject unsupported capabilities and unsafe URL forms', t => {
  const f = fixture(t);
  for (const value of [{ ...profile(), schemaVersion: 2 }, { ...profile(), trust: {} }, { ...profile(), command: 'sh' }, { ...profile(), providers: { npm: {} } }, { ...profile(), providers: { github: { unknown: 'https://x.test/' } } }]) assert.throws(() => validateProfile(value));
  for (const url of ['http://mirror.test/', 'https://user:secret@mirror.test/', 'https://mirror.test/?q=1', 'https://mirror.test/#fragment', 'https://mirror.test/{repo}/', 'https://mirror.test/a/../b', 'https://mirror.test/%2e%2e/b', 'https://mirror.test/a\\b']) assert.throws(() => validateProfile(profile('r', { rawBase: url })));
  assert.throws(() => validateProfile(profile('r', { rawBase: 'http://127.0.0.1/' })));
  assert.doesNotThrow(() => validateProfile(profile('r', { rawBase: 'http://127.0.0.1/' }), { allowHttp: true }));
  for (const trust of [{ forwardGitHubToken: 'true' }, { allowedHosts: ['*.test'] }, { shell: true }]) {
    f.write(f.settings, { schemaVersion: 1, source: { type: 'direct' }, trust });
    assert.throws(() => resolveSelection(f.opts));
  }
});
test('local endpoint overrides are rejected rather than shadowing the selected profile', async t => {
  const f = fixture(t);
  f.write(f.settings, { schemaVersion: 1, source: { type: 'direct' }, overrides: { providers: { github: { rawBase: 'https://shadow.test/' } } } });
  await assert.rejects(prepareUpstreams(f.opts), /overrides are not supported.*local profile/);
});
test('corrupt persistent selection never silently becomes direct', async t => {
  const f = fixture(t);
  f.write(f.settings, { schemaVersion: 22, source: { type: 'direct' } });
  await assert.rejects(prepareUpstreams(f.opts), /schemaVersion/);
  fs.writeFileSync(f.settings, '{broken');
  await assert.rejects(prepareUpstreams(f.opts), /Cannot read valid/);
});
test('explicit local source configuration has no remote cache and reloads in a fresh process', async t => {
  const f = fixture(t), file = path.join(f.dir, 'local.json');
  f.write(file, profile());
  const prepared = await prepareUpstreams({ ...f.opts, source: { type: 'local', path: file } });
  assert.equal(fs.existsSync(f.settings), false);
  assert.equal(fs.existsSync(f.cache), false);
  setUpstreamSource(file, f.opts);
  const loaded = await prepareUpstreams(f.opts);
  assert.equal(loaded.snapshot.github.apiBase, 'https://mirror.test/api/');
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `import {prepareUpstreams} from ${JSON.stringify(new URL('../upstreams.js', import.meta.url).href)}; console.log((await prepareUpstreams({zylosDir:process.argv[1],env:{}})).snapshot.github.rawBase)`, f.dir], { encoding: 'utf8' }).trim();
  assert.equal(result, 'https://mirror.test/raw/');
  await assert.rejects(prepareUpstreams({ ...f.opts, force: true }), /not applicable/);
});
test('first fetch writes atomic cache, fresh uses no network, 304 updates only successful check time', async t => {
  const f = await remote(t), now = 100000;
  const first = await prepareUpstreams({ ...f.opts, now });
  assert.equal(first.snapshot.revision, 'r1');
  assert.equal(fs.existsSync(f.settings), false);
  assert.equal(f.requests[0].path, '/config?variant=cn');
  assert.equal(f.requests[0].headers.authorization, undefined);
  await prepareUpstreams({ ...f.opts, now: now + 1 });
  assert.equal(f.requests.length, 1);
  f.setHandler((req, res) => { assert.equal(req.headers['if-none-match'], 'v1'); res.writeHead(304); res.end(); });
  const next = await prepareUpstreams({ ...f.opts, now: now + DEFAULT_TTL_MS });
  assert.equal(next.snapshot.checkedAt, now + DEFAULT_TTL_MS);
  assert.equal(next.snapshot.revision, 'r1');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(f.cache)), ['upstreams-cache.json']);
});
test('status is read-only even when expired/missing and redacts source query and npm values', async t => {
  const f = await remote(t);
  let result = await prepareUpstreams({ ...f.opts, readOnly: true });
  assert.equal(result.snapshot, null);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(f.cache), false);
  await prepareUpstreams({ ...f.opts, now: 100 });
  result = await prepareUpstreams({ ...f.opts, now: 100 + DEFAULT_TTL_MS, readOnly: true });
  const status = upstreamStatus(result, { resolved: true, env: { npm_config_registry: 'https://secret:password@registry.test/' } });
  assert.equal(status.cacheStatus, 'expired');
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.stringify(status).includes('variant'), false);
  assert.equal(JSON.stringify(status).includes('password'), false);
});
test('missing cache retains saved remote source and refetches; switching URL never reuses other source', async t => {
  const f = await remote(t);
  const first = await prepareUpstreams(f.opts);
  setUpstreamSource(f.url, f.opts);
  fs.unlinkSync(f.cache);
  const loaded = await prepareUpstreams({ ...f.opts, source: undefined });
  assert.equal(loaded.snapshot.source.type, 'remote');
  assert.equal(f.requests.length, 2);
  f.setHandler((_req, res) => { res.writeHead(503); res.end(); });
  await assert.rejects(prepareUpstreams({ ...f.opts, source: { type: 'remote', url: f.url.replace('variant=cn', 'variant=other') } }), /no valid same-source cache/);
  assert.equal(JSON.parse(fs.readFileSync(f.cache)).sourceUrl, f.url);
});
test('invalid generations preserve cache and timestamp; forced refresh returns failure', async t => {
  const f = await remote(t), warnings = [];
  await prepareUpstreams({ ...f.opts, now: 100 });
  const before = fs.readFileSync(f.cache, 'utf8');
  for (const body of ['{bad', JSON.stringify({ ...profile(), schemaVersion: 99 }), JSON.stringify({ ...profile(), trust: { forwardGitHubToken: true } })]) {
    f.setHandler((_req, res) => res.end(body));
    const old = await prepareUpstreams({ ...f.opts, now: DEFAULT_TTL_MS + 100, warn: msg => warnings.push(msg) });
    assert.equal(old.snapshot.revision, 'r1');
    assert.equal(fs.readFileSync(f.cache, 'utf8'), before);
    await assert.rejects(prepareUpstreams({ ...f.opts, force: true }), /previous cache preserved/);
  }
  assert.equal(warnings.length, 3);
});
test('first fetch invalid/304/oversize/timeout fails and writes no cache', async t => {
  const f = await remote(t);
  for (const handler of [(_q, res) => res.end('{bad'), (_q, res) => { res.writeHead(304); res.end(); }, (_q, res) => res.end('a'.repeat(1024 * 1024 + 1)), () => {}]) {
    f.setHandler(handler);
    await assert.rejects(prepareUpstreams({ ...f.opts, timeoutMs: 100 }), /no valid same-source cache/);
    assert.equal(fs.existsSync(f.cache), false);
  }
});
test('future check timestamp is rechecked; successful new profile replaces old generation completely', async t => {
  const f = await remote(t);
  await prepareUpstreams({ ...f.opts, now: 1000 });
  f.setHandler((_req, res) => res.end(JSON.stringify(profile('r2', { apiBase: 'https://new.test/prefix' }))));
  const next = await prepareUpstreams({ ...f.opts, now: 500 });
  assert.equal(f.requests.length, 2);
  assert.equal(next.snapshot.github.apiBase, 'https://new.test/prefix/');
  assert.equal(next.snapshot.github.rawBase, DIRECT_GITHUB.rawBase);
  assert.equal(next.snapshot.github.downloadBase, DIRECT_GITHUB.downloadBase);
});
test('trust survives remote replacement and direct persistence without endpoint layering', async t => {
  const f = await remote(t);
  f.write(f.settings, { schemaVersion: 1, source: f.opts.source, trust: { forwardGitHubToken: true, allowedHosts: ['local.test'] } });
  const first = await prepareUpstreams(f.opts);
  f.setHandler((_req, res) => res.end(JSON.stringify(profile('r2', {}))));
  const next = await prepareUpstreams({ ...f.opts, force: true });
  assert.deepEqual(next.snapshot.github, DIRECT_GITHUB);
  assert.deepEqual(next.snapshot.trust, first.snapshot.trust);
  const direct = await prepareUpstreams({ ...f.opts, source: { type: 'direct' } });
  assert.deepEqual(direct.snapshot.github, DIRECT_GITHUB);
  assert.deepEqual(direct.snapshot.trust, first.snapshot.trust);
  setUpstreamSource('direct', f.opts);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), { schemaVersion: 1, source: { type: 'direct' }, trust: first.snapshot.trust });
  assert.throws(() => { next.snapshot.trust.allowedHosts.push('attacker.test'); }, TypeError);
});
test('operation snapshot stays fixed through refresh, failure and rollback; concurrent scopes remain isolated', async t => {
  const f = await remote(t), first = await prepareUpstreams(f.opts);
  f.setHandler((_req, res) => res.end(JSON.stringify(profile('r2', { rawBase: 'https://next.test/' }))));
  await withUpstreamSnapshot(first, async () => {
    const before = githubUrl('raw', 'a/b', { ref: 'main', path: 'file' });
    const next = await prepareUpstreams({ ...f.opts, force: true });
    assert.equal(getUpstreamSnapshot().revision, 'r1');
    await Promise.all([
      withUpstreamSnapshot(next, async () => { await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(getUpstreamSnapshot().revision, 'r2'); }),
      (async () => { await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(getUpstreamSnapshot().revision, 'r1'); })(),
    ]);
    try { throw new Error('inject failure'); } catch { assert.equal(githubUrl('raw', 'a/b', { ref: 'main', path: 'file' }), before); }
  });
  assert.deepEqual(getUpstreamSnapshot().github, DIRECT_GITHUB);
});
test('parallel expired refreshes recheck the lock and make one network request', async t => {
  const f = await remote(t);
  f.setHandler((_req, res) => setTimeout(() => res.end(JSON.stringify(profile())), 100));
  const all = await Promise.all(Array.from({ length: 6 }, () => prepareUpstreams(f.opts)));
  assert.equal(f.requests.length, 1);
  assert.equal(new Set(all.map(result => result.snapshot.checkedAt)).size, 1);
});
test('interrupted cache rename preserves exact old bytes; failed settings save is explicit', async t => {
  const f = await remote(t);
  await prepareUpstreams({ ...f.opts, now: 1 });
  const before = fs.readFileSync(f.cache, 'utf8'), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === f.cache || to === f.settings) throw Object.assign(new Error('injected write failure'), { code: 'EIO' }); return rename(from, to); };
  try {
    const fallback = await prepareUpstreams({ ...f.opts, now: DEFAULT_TTL_MS + 1, warn: () => {} });
    assert.equal(fallback.snapshot.revision, 'r1');
    assert.equal(fs.readFileSync(f.cache, 'utf8'), before);
    assert.throws(() => setUpstreamSource(f.url, f.opts), /could not be saved/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readdirSync(path.dirname(f.cache)), ['upstreams-cache.json']);
});
test('dead refresher lock recovers without dropping valid cache', async t => {
  const f = await remote(t);
  f.write(path.join(f.dir, '.zylos/upstreams-cache.lock'), { pid: 2147483647, nonce: 'dead-writer' });
  const result = await prepareUpstreams(f.opts);
  assert.equal(result.snapshot.revision, 'r1');
  assert.equal(result.cacheStatus, 'fresh');
  assert.deepEqual(fs.readdirSync(path.dirname(f.cache)), ['upstreams-cache.json']);
});
test('URL builders preserve proxy prefixes and encode params while rejecting traversal', async t => {
  const f = fixture(t), file = path.join(f.dir, 'local.json');
  f.write(file, profile());
  const prepared = await prepareUpstreams({ ...f.opts, source: { type: 'local', path: file } });
  await withUpstreamSnapshot(prepared, () => {
    assert.equal(githubUrl('contents', 'org/repo', { ref: 'feat/a b', path: 'a b/file.md' }), 'https://mirror.test/api/repos/org/repo/contents/a%20b/file.md?ref=feat%2Fa%20b');
    assert.equal(githubUrl('archive', 'org/repo', { ref: 'feat/x', refType: 'branch' }), 'https://mirror.test/download/org/repo/archive/refs/heads/feat/x.tar.gz');
    assert.equal(githubUrl('tarball', 'org/repo', { ref: 'v1' }), 'https://mirror.test/api/repos/org/repo/tarball/v1');
    assert.equal(githubUrl('releaseLatest', 'caddyserver/caddy'), 'https://mirror.test/api/repos/caddyserver/caddy/releases/latest');
    assert.equal(githubUrl('releaseAsset', 'caddyserver/caddy', { ref: 'v1', asset: 'caddy_linux.tar.gz' }), 'https://mirror.test/download/caddyserver/caddy/releases/download/v1/caddy_linux.tar.gz');
    for (const unsafe of ['../secret', '%2e%2e/secret', 'a/../b', 'x\\y', '%2fetc']) assert.throws(() => githubUrl('raw', 'org/repo', { ref: 'main', path: unsafe }));
  });
});
test('profile redirects preserve query, strip all auth, and reject non-local HTTP', async t => {
  const f = await remote(t);
  f.setHandler((req, res) => {
    if (req.url.startsWith('/config?')) { res.writeHead(302, { Location: '/destination?keep=yes' }); res.end(); }
    else res.end(JSON.stringify(profile()));
  });
  await prepareUpstreams(f.opts);
  assert.equal(f.requests[1].path, '/destination?keep=yes');
  assert.equal(f.requests[1].headers.authorization, undefined);
  f.setHandler((_req, res) => { res.writeHead(302, { Location: 'http://external.test/profile' }); res.end(); });
  await assert.rejects(prepareUpstreams({ ...f.opts, force: true }), /refresh failed/);
});

test('cache dates outside JavaScript Date range are invalid rather than crashing status', async t => {
  const f = await remote(t);
  await prepareUpstreams(f.opts);
  const cache = JSON.parse(fs.readFileSync(f.cache));
  cache.checkedAt = 1e99;
  f.write(f.cache, cache);
  const state = await prepareUpstreams({ ...f.opts, readOnly: true });
  assert.equal(upstreamStatus(state).cacheStatus, 'missing-or-invalid');
});
test('orphaned recovery owner is recovered and lock publication never exposes partial metadata', async t => {
  const f = await remote(t), lock = path.join(f.dir, '.zylos/upstreams-cache.lock');
  f.write(lock, { pid: 2147483647, nonce: 'dead-lock' });
  f.write(`${lock}.recovery`, { pid: 2147483647, nonce: 'dead-recovery' });
  await prepareUpstreams(f.opts);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(`${lock}.recovery`), false);
  fs.unlinkSync(f.cache);
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    const metadata = JSON.parse(fs.readFileSync(from));
    assert.equal(metadata.pid, process.pid);
    assert.ok(metadata.nonce);
    if (to === lock) throw new Error('injected crash before atomic lock publication');
    return link(from, to);
  };
  try { await assert.rejects(prepareUpstreams(f.opts), /no valid same-source cache/); }
  finally { fs.linkSync = link; }
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(f.cache), false);
  assert.equal((await prepareUpstreams(f.opts)).snapshot.revision, 'r1');
});
test('saved source changed while waiting resolves the new source instead of overwriting its cache', async t => {
  const f = await remote(t), lock = path.join(f.dir, '.zylos/upstreams-cache.lock');
  f.write(f.settings, { schemaVersion: 1, source: f.opts.source });
  f.write(lock, { pid: process.pid, nonce: 'another-operation' });
  const waiting = prepareUpstreams({ ...f.opts, source: undefined });
  await new Promise(resolve => setTimeout(resolve, 20));
  const newUrl = f.url.replace('variant=cn', 'variant=new');
  f.write(f.settings, { schemaVersion: 1, source: { type: 'remote', url: newUrl } });
  f.write(f.cache, { schemaVersion: 1, sourceUrl: newUrl, profile: profile('new-source'), checkedAt: Date.now() });
  fs.unlinkSync(lock);
  const result = await waiting;
  assert.equal(result.snapshot.revision, 'new-source');
  assert.equal(result.snapshot.source.url, newUrl);
  assert.equal(f.requests.length, 0);
});
test('profile connection errors explain local-file fallback without leaking transport details', async t => {
  const f = await remote(t), warnings = [];
  const bin = path.join(f.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\necho "https://secret:password@proxy.test/?token=private" >&2\nexit 7\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + originalPath;
  t.after(() => { process.env.PATH = originalPath; });
  const safeDiagnostic = message => {
    assert.match(message, /curl/);
    assert.match(message, /--upstream-config/);
    assert.doesNotMatch(message, /secret|password|proxy\.test|private/);
  };
  await assert.rejects(prepareUpstreams(f.opts), err => { safeDiagnostic(err.message); return true; });
  assert.equal(fs.existsSync(f.cache), false);
  f.write(f.cache, { schemaVersion: 1, sourceUrl: f.url, profile: profile('cached'), checkedAt: 100 });
  const before = fs.readFileSync(f.cache, 'utf8');
  const result = await prepareUpstreams({ ...f.opts, now: 100 + DEFAULT_TTL_MS, warn: message => warnings.push(message) });
  assert.equal(result.snapshot.revision, 'cached');
  assert.equal(warnings.length, 1);
  safeDiagnostic(warnings[0]);
  await assert.rejects(prepareUpstreams({ ...f.opts, force: true }), err => { safeDiagnostic(err.message); return true; });
  assert.equal(fs.readFileSync(f.cache, 'utf8'), before);
});
test('unverifiable refresh lock reports its path without reclaiming it or changing cache', async t => {
  const f = await remote(t), lock = path.join(f.dir, '.zylos/upstreams-cache.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '{broken');
  const reportsLock = err => {
    assert.ok(err.message.includes(lock), err.message);
    assert.match(err.message, /check its owner before removing/);
    return true;
  };
  await assert.rejects(prepareUpstreams({ ...f.opts, timeoutMs: 1 }), reportsLock);
  assert.equal(fs.readFileSync(lock, 'utf8'), '{broken');
  assert.equal(fs.existsSync(f.cache), false);
  assert.equal(f.requests.length, 0);

  f.write(f.cache, { schemaVersion: 1, sourceUrl: f.url, profile: profile('cached'), checkedAt: 100 });
  const before = fs.readFileSync(f.cache, 'utf8'), warnings = [];
  const result = await prepareUpstreams({ ...f.opts, timeoutMs: 1, now: 100 + DEFAULT_TTL_MS, warn: message => warnings.push(message) });
  assert.equal(result.snapshot.revision, 'cached');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(lock));
  assert.equal(fs.readFileSync(f.cache, 'utf8'), before);

  const badOwner = { pid: 'invalid', nonce: 'unknown-owner' };
  f.write(lock, badOwner);
  await assert.rejects(prepareUpstreams({ ...f.opts, timeoutMs: 1, force: true }), reportsLock);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), badOwner);
  assert.equal(fs.readFileSync(f.cache, 'utf8'), before);
  assert.equal(f.requests.length, 0);
});
test('older explicit source waiter cannot overwrite another source newly cached during the wait', async t => {
  const f = await remote(t), lock = path.join(f.dir, '.zylos/upstreams-cache.lock');
  f.write(lock, { pid: process.pid, nonce: 'another-operation' });
  const waiting = prepareUpstreams(f.opts);
  await new Promise(resolve => setTimeout(resolve, 20));
  const newUrl = f.url.replace('variant=cn', 'variant=new');
  f.write(f.cache, { schemaVersion: 1, sourceUrl: newUrl, profile: profile('new-source'), checkedAt: Date.now() });
  fs.unlinkSync(lock);
  await assert.rejects(waiting, /source changed/);
  assert.equal(JSON.parse(fs.readFileSync(f.cache)).sourceUrl, newUrl);
  assert.equal(f.requests.length, 0);
});

test('connection failure gives proxy alternatives without exposing transport details', async t => {
  const f = await remote(t);
  f.setHandler((req) => req.socket.destroy());
  await assert.rejects(prepareUpstreams(f.opts), err => {
    assert.match(err.message, /curl/);
    assert.match(err.message, /--upstream-config/);
    assert.doesNotMatch(err.message, /NODE_USE_ENV_PROXY/);
    assert(!err.message.includes(f.url));
    return true;
  });
  assert.equal(fs.existsSync(f.cache), false);
});

test('official template supports a deployment-owned cn.json without a named preset', async t => {
  const f = fixture(t), file = path.join(f.dir, 'cn.json');
  const template = JSON.parse(fs.readFileSync(new URL('../../../templates/upstreams.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateProfile(template).providers.github, DIRECT_GITHUB);
  template.providers.github.apiBase = 'https://private.example.test/api/';
  f.write(file, template);
  const prepared = await prepareUpstreams({ ...f.opts, source: { type: 'local', path: file } });
  assert.equal(prepared.snapshot.github.apiBase, template.providers.github.apiBase);
  assert.equal(prepared.snapshot.github.rawBase, DIRECT_GITHUB.rawBase);
  setUpstreamSource(file, f.opts);
  assert.equal((await prepareUpstreams(f.opts)).snapshot.github.apiBase, template.providers.github.apiBase);
});

test('profile curl ignores user curlrc authentication and enforces chunked body limit', async t => {
  const f = await remote(t);
  fs.writeFileSync(path.join(f.dir, '.curlrc'), 'header = "Authorization: Bearer curlrc-secret"\nlocation\ninsecure\n');
  const oldCurlHome = process.env.CURL_HOME;
  process.env.CURL_HOME = f.dir;
  t.after(() => { if (oldCurlHome === undefined) delete process.env.CURL_HOME; else process.env.CURL_HOME = oldCurlHome; });
  await prepareUpstreams(f.opts);
  assert.equal(f.requests[0].headers.authorization, undefined);
  const before = fs.readFileSync(f.cache, 'utf8');
  f.setHandler((_req, res) => {
    res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
    res.write('a'.repeat(600 * 1024));
    res.end('b'.repeat(600 * 1024));
  });
  await assert.rejects(prepareUpstreams({ ...f.opts, force: true }), /previous cache preserved/);
  assert.equal(fs.readFileSync(f.cache, 'utf8'), before);
});

test('curl profile parses interim headers and bounds final headers', async t => {
  const f = await remote(t);
  f.setHandler((_req, res) => { res.writeContinue(); res.end(JSON.stringify(profile())); });
  assert.equal((await prepareUpstreams(f.opts)).snapshot.revision, 'r1');
  const before = fs.readFileSync(f.cache, 'utf8');
  f.setHandler((_req, res) => { res.setHeader('X-Large', 'x'.repeat(70 * 1024)); res.end(JSON.stringify(profile())); });
  await assert.rejects(prepareUpstreams({ ...f.opts, force: true }), /previous cache preserved/);
  assert.equal(fs.readFileSync(f.cache, 'utf8'), before);
});

test('curl profile redirect hops share one total timeout', async t => {
  const f = await remote(t);
  f.setHandler((req, res) => {
    setTimeout(() => {
      if (req.url.startsWith('/config')) { res.writeHead(302, { Location: '/final' }); res.end(); }
      else res.end(JSON.stringify(profile()));
    }, 160);
  });
  await assert.rejects(prepareUpstreams({ ...f.opts, timeoutMs: 250 }), /no valid same-source cache/);
  assert.equal(fs.existsSync(f.cache), false);
  assert.equal((await prepareUpstreams({ ...f.opts, timeoutMs: 2000 })).snapshot.revision, 'r1');
});

test('remote environment override may cache a response but never persists its source', async t => {
  const f = await remote(t);
  const prepared = await prepareUpstreams({ ...f.opts, source: undefined, env: { ZYLOS_UPSTREAM_CONFIG: f.url } });
  assert.equal(prepared.selection.selectedBy, 'environment');
  assert.equal(prepared.snapshot.revision, 'r1');
  assert.equal(fs.existsSync(f.cache), true);
  assert.equal(fs.existsSync(f.settings), false);
  assert.deepEqual((await prepareUpstreams({ ...f.opts, source: undefined, env: {} })).snapshot.github, DIRECT_GITHUB);
});


test('clear removes only source, preserves trust/cache/profile and leaves absent settings diskless', async t => {
  const f = fixture(t), file = path.join(f.dir, 'local.json');
  clearUpstreamSource(f.opts);
  assert.equal(fs.existsSync(path.dirname(f.settings)), false);
  f.write(file, profile());
  const trust = { forwardGitHubToken: true, allowedHosts: ['mirror.test'] };
  f.write(f.settings, { schemaVersion: 1, source: { type: 'local', path: file }, trust });
  f.write(f.cache, { deliberately: 'preserve these exact bytes' });
  const cacheBefore = fs.readFileSync(f.cache, 'utf8'), profileBefore = fs.readFileSync(file, 'utf8');
  for (let cycle = 0; cycle < 3; cycle++) {
    setUpstreamSource(file, f.opts);
    assert.equal(resolveSelection(f.opts).selectedBy, 'saved');
    clearUpstreamSource({ ...f.opts, env: { ZYLOS_UPSTREAM_CONFIG: '' } });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.settings)), { schemaVersion: 1, trust });
    const cleared = await prepareUpstreams(f.opts);
    assert.equal(cleared.selection.selectedBy, 'default');
    assert.deepEqual(cleared.snapshot.github, DIRECT_GITHUB);
    assert.deepEqual(cleared.snapshot.trust, trust);
    assert.equal(fs.readFileSync(f.cache, 'utf8'), cacheBefore);
    assert.equal(fs.readFileSync(file, 'utf8'), profileBefore);
    assert.equal(resolveSelection({ ...f.opts, env: { ZYLOS_UPSTREAM_CONFIG: file } }).selectedBy, 'environment');
    setUpstreamSource('direct', f.opts);
    assert.equal(resolveSelection(f.opts).selectedBy, 'saved');
    assert.deepEqual((await prepareUpstreams(f.opts)).snapshot.github, DIRECT_GITHUB);
  }
});

test('set validates before writing, ignores ambient current selector and failed clear preserves settings', t => {
  const f = fixture(t), file = path.join(f.dir, 'bad.json');
  setUpstreamSource('https://config.test/profile?q=one', { ...f.opts, env: { ZYLOS_UPSTREAM_CONFIG: '' } });
  const before = fs.readFileSync(f.settings, 'utf8');
  f.write(file, { bad: 'profile' });
  for (const value of ['', 'http://config.test/p', 'https://u:p@config.test/p', 'https://config.test/p#frag', file, path.join(f.dir, 'missing.json')]) {
    assert.throws(() => setUpstreamSource(value, f.opts));
    assert.equal(fs.readFileSync(f.settings, 'utf8'), before);
  }
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('injected failure'); };
  try { assert.throws(() => clearUpstreamSource(f.opts), /could not be saved/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.settings, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.settings)), ['upstreams.json']);
});


test('explicit set and clear cannot change an active operation or its rollback snapshot', async t => {
  const f = fixture(t), file = path.join(f.dir, 'local.json');
  f.write(file, profile());
  setUpstreamSource(file, f.opts);
  const initial = await prepareUpstreams(f.opts);
  await withUpstreamSnapshot(initial, async () => {
    const before = githubUrl('raw', 'a/b', { ref: 'main', path: 'file' });
    setUpstreamSource('direct', f.opts);
    assert.deepEqual((await prepareUpstreams(f.opts)).snapshot.github, DIRECT_GITHUB);
    clearUpstreamSource(f.opts);
    try { throw new Error('operation failed'); }
    catch { assert.equal(githubUrl('raw', 'a/b', { ref: 'main', path: 'file' }), before); }
  });
  assert.equal(resolveSelection(f.opts).selectedBy, 'default');
});

test('saved remote cleared while waiting reselects direct without using or rewriting old cache', async t => {
  const f = await remote(t), lock = path.join(f.dir, '.zylos/upstreams-cache.lock');
  f.write(f.settings, { schemaVersion: 1, source: f.opts.source });
  f.write(f.cache, { schemaVersion: 1, sourceUrl: f.url, profile: profile(), checkedAt: 1 });
  const before = fs.readFileSync(f.cache, 'utf8');
  f.write(lock, { pid: process.pid, nonce: 'other-operation' });
  const waiting = prepareUpstreams({ ...f.opts, source: undefined });
  await new Promise(resolve => setTimeout(resolve, 20));
  clearUpstreamSource(f.opts);
  fs.unlinkSync(lock);
  const result = await waiting;
  assert.equal(result.selection.selectedBy, 'default');
  assert.deepEqual(result.snapshot.github, DIRECT_GITHUB);
  assert.equal(fs.readFileSync(f.cache, 'utf8'), before);
  assert.equal(f.requests.length, 0);
});
