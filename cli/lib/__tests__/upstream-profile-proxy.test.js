import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const cli = fileURLToPath(new URL('../../zylos.js', import.meta.url));
const hostname = 'profile-proxy-test.invalid';
const token = 'dummy-github-token-must-not-reach-profile';
const proxyAuthorization = `Basic ${Buffer.from('proxy-user:proxy-secret').toString('base64')}`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

// Spawn asynchronously: the local HTTPS origin and CONNECT proxy must remain
// responsive while the real CLI waits for its real curl child process.
function runCli(env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'upstream', 'refresh'], { env, cwd });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`CLI did not finish normally: ${signal}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

test('remote profile CLI obeys HTTPS_PROXY and NO_PROXY with real curl and verified TLS', { timeout: 70000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-profile-proxy-'));
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  };
  const servers = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Config syntax works with both OpenSSL and LibreSSL; no -k or host-file edit.
  const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem');
  const config = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(config, `[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = ext\n[dn]\nCN = ${hostname}\n[ext]\nsubjectAltName = DNS:${hostname}\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage = serverAuth\n`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-config', config], { stdio: 'pipe' });

  const requests = [], connects = [];
  const origin = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    res.setHeader('ETag', 'proxy-profile-v1');
    res.end(JSON.stringify({ schemaVersion: 1, revision: 'through-connect-proxy', providers: { github: { apiBase: 'https://api.github.com/', rawBase: 'https://raw.githubusercontent.com/', downloadBase: 'https://github.com/' } } }));
  });
  origin.on('connection', track);
  servers.push(origin);
  await listen(origin);
  const originPort = origin.address().port;
  const sourceUrl = `https://${hostname}:${originPort}/profile.json`;

  const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => {
    connects.push({ url: req.url, headers: req.headers });
    if (req.url !== `${hostname}:${originPort}` || req.headers['proxy-authorization'] !== proxyAuthorization) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    // Only the proxy knows how this otherwise unresolvable name reaches origin.
    const upstream = track(net.connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    }));
    client.on('close', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  servers.push(proxy);
  await listen(proxy);
  const proxyUrl = `http://proxy-user:proxy-secret@127.0.0.1:${proxy.address().port}`;

  async function run(name, extraEnv) {
    const home = path.join(dir, name), zylosDir = path.join(home, 'zylos');
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, '.zylos', 'upstreams.json'), JSON.stringify({ schemaVersion: 1, source: { type: 'remote', url: sourceUrl } }));
    // Deliberate allowlist excludes the developer machine's proxy, Node options,
    // custom upstream selection and credentials. Only a dummy GitHub token exists.
    const env = { PATH: process.env.PATH, HOME: home, ZYLOS_DIR: zylosDir, CURL_CA_BUNDLE: cert, GITHUB_TOKEN: token, ...extraEnv };
    return { ...await runCli(env, home), cache: path.join(zylosDir, '.zylos', 'upstreams-cache.json') };
  }

  await t.test('positive control: authenticated CONNECT retrieves HTTPS profile without origin credentials', async () => {
    const result = await run('proxied', { HTTPS_PROXY: proxyUrl });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(connects.length, 1);
    assert.equal(connects[0].url, `${hostname}:${originPort}`);
    assert.equal(connects[0].headers['proxy-authorization'], proxyAuthorization);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/profile.json');
    assert.equal(requests[0].headers.authorization, undefined);
    assert.equal(requests[0].headers['proxy-authorization'], undefined);
    assert.equal(JSON.stringify(requests).includes(token), false);
    assert.equal(JSON.parse(fs.readFileSync(result.cache)).profile.revision, 'through-connect-proxy');
  });

  await t.test('TLS negative control: proxy access without the test CA cannot trust the profile', async () => {
    const before = [connects.length, requests.length];
    const result = await run('untrusted-origin', { HTTPS_PROXY: proxyUrl, CURL_CA_BUNDLE: undefined });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Upstream refresh failed/);
    assert.equal(fs.existsSync(result.cache), false);
    assert.equal(connects.length, before[0] + 1);
    assert.equal(requests.length, before[1]);
  });

  await t.test('negative control: no proxy cannot resolve the profile and creates no cache', async () => {
    const before = [connects.length, requests.length];
    const result = await run('without-proxy', {});
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Upstream refresh failed/);
    assert.equal(fs.existsSync(result.cache), false);
    assert.deepEqual([connects.length, requests.length], before);
  });

  await t.test('NO_PROXY bypasses an otherwise working HTTPS_PROXY', async () => {
    const before = [connects.length, requests.length];
    const result = await run('bypass-proxy', { HTTPS_PROXY: proxyUrl, NO_PROXY: hostname });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Upstream refresh failed/);
    assert.equal(fs.existsSync(result.cache), false);
    assert.deepEqual([connects.length, requests.length], before);
    assert.equal(result.stderr.includes('proxy-secret'), false);
    assert.equal(result.stderr.includes(token), false);
  });
});
