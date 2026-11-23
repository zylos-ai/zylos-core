import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  resolveSelection, validateProfile,
  prepareUpstreams,
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
test('corrupt persistent selection never silently becomes direct', async t => {
  const f = fixture(t);
  f.write(f.settings, { schemaVersion: 22, source: { type: 'direct' } });
  await assert.rejects(prepareUpstreams(f.opts), /schemaVersion/);
  fs.writeFileSync(f.settings, '{broken');
  await assert.rejects(prepareUpstreams(f.opts), /Cannot read valid/);
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
