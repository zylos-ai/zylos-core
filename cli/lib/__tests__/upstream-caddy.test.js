import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

test('Caddy discovers version and extracts its binary through generic GitHub routes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-caddy-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'shim'), source = path.join(dir, 'archive');
  fs.mkdirSync(bin); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'caddy'), 'inert Caddy test binary');
  const tarball = path.join(dir, 'caddy.tar.gz'), log = path.join(dir, 'requests');
  execFileSync('tar', ['czf', tarball, '-C', source, 'caddy']);
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2), url = argv.at(-1);
if (!url.startsWith('https://mirror.test/')) { console.error('Blocked unexpected upstream'); process.exit(3); }
fs.appendFileSync(${JSON.stringify(log)}, url+'\\n');
if (argv.includes('-D')) fs.writeFileSync(argv[argv.indexOf('-D')+1], 'HTTP/1.1 200 OK\\r\\n\\r\\n');
if (url === 'https://mirror.test/api/repos/caddyserver/caddy/releases/latest') process.stdout.write(JSON.stringify({ tag_name: 'v2.10.2' }));
else if (/^https:\\/\\/mirror.test\\/download\\/caddyserver\\/caddy\\/releases\\/download\\/v2.10.2\\/caddy_2.10.2_(mac|linux)_(amd64|arm64|armv7)\\.tar\\.gz$/.test(url)) fs.copyFileSync(${JSON.stringify(tarball)}, argv[argv.indexOf('-o')+1]);
else { console.error('Unexpected URL: '+url); process.exit(4); }
`, { mode: 0o755 });
  const profile = path.join(dir, 'profile.json');
  fs.writeFileSync(profile, JSON.stringify({ schemaVersion: 1, revision: 'caddy-test', providers: { github: { apiBase: 'https://mirror.test/api/', downloadBase: 'https://mirror.test/download/' } } }));
  const init = new URL('../../commands/init.js', import.meta.url).href;
  const upstream = new URL('../upstreams.js', import.meta.url).href;
  const script = `
    import { downloadCaddy } from ${JSON.stringify(init)};
    import { prepareUpstreams, withUpstreamSnapshot } from ${JSON.stringify(upstream)};
    const p = await prepareUpstreams({ source: {type:'local',path:process.argv[1]}, env: {} });
    const ok = await withUpstreamSnapshot(p, () => downloadCaddy() && downloadCaddy());
    if (!ok) process.exitCode = 1;
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script, profile], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, ZYLOS_DIR: path.join(dir, 'home'), PATH: bin + path.delimiter + process.env.PATH },
  });
  const urls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(urls.length, 2); // Existing binary is reused, with no extra request.
  assert.equal(urls[0], 'https://mirror.test/api/repos/caddyserver/caddy/releases/latest');
  assert.match(urls[1], /\/download\/caddyserver\/caddy\/releases\/download\/v2.10.2\/caddy_/);
  assert.equal(fs.readFileSync(path.join(dir, 'home/bin/caddy'), 'utf8'), 'inert Caddy test binary');
  assert.equal(fs.statSync(path.join(dir, 'home/bin/caddy')).mode & 0o111, 0o111);
});
