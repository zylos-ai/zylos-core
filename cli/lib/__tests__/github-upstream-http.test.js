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

  test(`${name}: public requests never acquire token; plaintext never receives token`, async t => {
    const calls = fixture(t, {
      'https://mirror.test/file': { body: 'ok' }, 'http://127.0.0.1:1234/file': { body: 'local' },
    });
    const snapshot = { allowHttp: true, trust: { forwardGitHubToken: true, allowedHosts: ['mirror.test', '127.0.0.1:1234'] } };
    await request('https://mirror.test/file', { snapshot });
    await request('http://127.0.0.1:1234/file', { token: 'secret', snapshot });
    assert(calls().every(call => call.input === ''));
  });

}

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
