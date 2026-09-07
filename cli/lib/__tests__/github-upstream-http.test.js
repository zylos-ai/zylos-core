import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { githubRequestSync, githubRequestAsync } from '../github-http.js';

function fixture(t, routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-upstream-test-'));
  const oldPath = process.env.PATH;
  const log = path.join(dir, 'requests');
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify(routes));
  fs.writeFileSync(path.join(dir, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.at(-1);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({url,args,input})+'\\n');
const response = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'routes.json'))}, 'utf8'))[url];
if (!response) { console.error('UNEXPECTED NETWORK '+url); process.exit(2); }
const status = response.status || 200;
if (args.includes('-D')) fs.writeFileSync(args[args.indexOf('-D')+1], 'HTTP/1.1 '+status+' Result\\r\\n'+(response.location ? 'Location: '+response.location+'\\r\\n' : '')+'\\r\\n');
if (status >= 400) { console.error('curl: (22) The requested URL returned error: '+status); process.exit(22); }
if (args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o')+1], response.body || '');
else process.stdout.write(response.body || '');
`, { mode: 0o755 });
  process.env.PATH = dir + path.delimiter + oldPath;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); });
  return () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
}

for (const [name, request] of [['sync', githubRequestSync], ['async', githubRequestAsync]]) {
  test(`${name}: custom auth requires local flag and exact allowed host`, async t => {
    const calls = fixture(t, { 'https://mirror.test/prefix/file': { body: 'ok' } });
    for (const trust of [undefined, { forwardGitHubToken: true, allowedHosts: [] },
      { forwardGitHubToken: false, allowedHosts: ['mirror.test'] },
      { forwardGitHubToken: true, allowedHosts: ['test'] }]) {
      assert.equal(await request('https://mirror.test/prefix/file', { token: 'secret', snapshot: { trust } }), 'ok');
    }
    assert(calls().every(call => !call.input.includes('secret') && !call.args.join(' ').includes('secret')));
    await request('https://mirror.test/prefix/file', {
      token: 'secret', snapshot: { trust: { forwardGitHubToken: true, allowedHosts: ['mirror.test'] } },
    });
    assert.match(calls().at(-1).input, /Authorization: Bearer secret/);
    assert(!calls().at(-1).args.join(' ').includes('secret'));
  });

  test(`${name}: redirects recheck each host and retain path/query`, async t => {
    const calls = fixture(t, {
      'https://mirror.test/prefix/start': { status: 302, location: '../next?q=1' },
      'https://mirror.test/next?q=1': { status: 307, location: 'https://untrusted.test/asset' },
      'https://untrusted.test/asset': { body: 'asset' },
    });
    assert.equal(await request('https://mirror.test/prefix/start', {
      token: 'secret', snapshot: { trust: { forwardGitHubToken: true, allowedHosts: ['mirror.test'] } },
    }), 'asset');
    assert.equal(calls().length, 3);
    assert.match(calls()[0].input, /secret/);
    assert.match(calls()[1].input, /secret/);
    assert.equal(calls()[2].input, '');
    assert(calls().every(call => call.args[0] === '-q' && !call.args.includes('-fsSL')));
  });

  test(`${name}: custom-to-official redirects require explicit token permission`, async t => {
    const calls = fixture(t, {
      'https://mirror.test/private': { status: 302, location: 'https://github.com/owner/private/archive/main.tar.gz' },
      'https://github.com/owner/private/archive/main.tar.gz': { body: 'archive' },
    });
    for (const allowedHosts of [['mirror.test'], ['mirror.test', 'github.com']]) {
      assert.equal(await request('https://mirror.test/private', {
        token: 'secret', snapshot: { trust: { forwardGitHubToken: true, allowedHosts } },
      }), 'archive');
    }
    assert.equal(calls()[1].input, '');
    assert.match(calls()[3].input, /Authorization: Bearer secret/);
    assert(calls().every(call => call.args[0] === '-q' && !call.args.includes('-fsSL')));
  });

  test(`${name}: public requests never acquire token; plaintext never receives token`, async t => {
    const calls = fixture(t, {
      'https://mirror.test/file': { body: 'ok' }, 'http://127.0.0.1:1234/file': { body: 'local' },
    });
    const snapshot = { allowHttp: true, trust: { forwardGitHubToken: true, allowedHosts: ['mirror.test', '127.0.0.1:1234'] } };
    await request('https://mirror.test/file', { snapshot });
    await request('http://127.0.0.1:1234/file', { token: 'secret', snapshot });
    assert(calls().every(call => call.input === ''));
  });

  test(`${name}: unsafe redirect target rejected before curl`, async t => {
    const calls = fixture(t, {
      'https://mirror.test/file': { status: 302, location: 'https://user:password@other.test/file' },
    });
    await assert.rejects(async () => request('https://mirror.test/file'), /Unsafe GitHub upstream redirect/);
    assert.equal(calls().length, 1);
  });

  test(`${name}: direct GitHub preserves curl redirect and auth contract`, async t => {
    const calls = fixture(t, { 'https://api.github.com/repos/org/repo/tags?per_page=100': { body: '[]' } });
    assert.equal(await request('https://api.github.com/repos/org/repo/tags?per_page=100', { token: 'secret' }), '[]');
    assert(calls()[0].args.includes('-fsSL'));
    assert.match(calls()[0].input, /Authorization: Bearer secret/);
  });
}

test('public helpers route raw fallback, sync/async tags, archive and API fallback through one snapshot', async t => {
  const calls = fixture(t, {
    'https://api.mirror.test/p/repos/org/repo/contents/SKILL.md?ref=main': { status: 404 },
    'https://raw.mirror.test/p/org/repo/main/SKILL.md': { body: 'file' },
    'https://api.mirror.test/p/repos/org/repo/tags?per_page=100': { body: '[{"name":"v1.2.3"}]' },
    'https://download.mirror.test/p/org/repo/archive/refs/tags/v1.0.0.tar.gz': { status: 404 },
    'https://download.mirror.test/p/org/repo/archive/refs/heads/main.tar.gz': { status: 404 },
    'https://api.mirror.test/p/repos/org/repo/tarball/v1.0.0': { status: 404 },
    'https://api.mirror.test/p/repos/org/repo/tarball/main': { status: 404 },
  });
  const oldToken = process.env.GITHUB_TOKEN;
  const oldRetry = process.env.ZYLOS_GH_RETRY_DELAY_MS;
  process.env.GITHUB_TOKEN = 'secret';
  process.env.ZYLOS_GH_RETRY_DELAY_MS = '';
  t.after(() => {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = oldToken;
    if (oldRetry === undefined) delete process.env.ZYLOS_GH_RETRY_DELAY_MS; else process.env.ZYLOS_GH_RETRY_DELAY_MS = oldRetry;
  });
  const { withUpstreamSnapshot } = await import('../upstreams.js');
  const { fetchRawFile, fetchLatestTag, fetchLatestTagAsync } = await import('../github.js');
  const { downloadArchive, downloadBranch } = await import('../download.js');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'github-routing-output-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  const snapshot = {
    github: { apiBase: 'https://api.mirror.test/p/', rawBase: 'https://raw.mirror.test/p/', downloadBase: 'https://download.mirror.test/p/' },
    trust: { forwardGitHubToken: false, allowedHosts: [] },
  };
  await withUpstreamSnapshot({ snapshot }, async () => {
    assert.equal(fetchRawFile('org/repo', 'SKILL.md'), 'file');
    assert.equal(fetchLatestTag('org/repo'), '1.2.3');
    assert.equal(await fetchLatestTagAsync('org/repo'), '1.2.3');
    assert.equal(downloadArchive('org/repo', '1.0.0', dest).success, false);
    assert.equal(downloadBranch('org/repo', 'main', dest).success, false);
  });
  assert.equal(calls().length, 8);
  assert(calls().every(call => !call.input.includes('secret')));
  assert.deepEqual(calls().slice(-4).map(call => call.url), [
    'https://download.mirror.test/p/org/repo/archive/refs/tags/v1.0.0.tar.gz',
    'https://api.mirror.test/p/repos/org/repo/tarball/v1.0.0',
    'https://download.mirror.test/p/org/repo/archive/refs/heads/main.tar.gz',
    'https://api.mirror.test/p/repos/org/repo/tarball/main',
  ]);
});

test('HTTPS mirror cannot redirect to plaintext loopback without explicit test opt-in', t => {
  const calls = fixture(t, {
    'https://mirror.test/start': { status: 302, location: 'http://127.0.0.1:1234/end' },
    'http://127.0.0.1:1234/end': { body: 'ok' },
  });
  assert.throws(() => githubRequestSync('https://mirror.test/start'), /Unsafe/);
  assert.equal(calls().length, 1);
  assert.equal(githubRequestSync('https://mirror.test/start', { snapshot: { allowHttp: true } }), 'ok');
  assert.equal(calls().at(-1).url, 'http://127.0.0.1:1234/end');
});

test('real custom-route curl ignores curlrc auto-follow and injected authorization', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-curlrc-'));
  const original = process.env.CURL_HOME;
  process.env.CURL_HOME = dir;
  fs.writeFileSync(path.join(dir, '.curlrc'), 'location\nheader = "Authorization: Bearer curlrc-secret"\n');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === '/start') {
      res.writeHead(302, { Location: `http://user:pass@127.0.0.1:${server.address().port}/final` });
      res.end();
    } else res.end('followed');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (original === undefined) delete process.env.CURL_HOME; else process.env.CURL_HOME = original;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/start`;
  // Positive control proves this curlrc actually enables bypass on ordinary curl.
  assert.equal((await promisify(execFile)('curl', ['-fsS', url], { timeout: 5000 })).stdout, 'followed');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].authorization, 'Bearer curlrc-secret');
  requests.length = 0;
  await assert.rejects(githubRequestAsync(url, { snapshot: { allowHttp: true } }), /Unsafe GitHub upstream redirect/);
  assert.deepEqual(requests, [{ url: '/start', authorization: undefined }]);
});
