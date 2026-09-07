import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const cli = path.resolve(import.meta.dirname, '../../zylos.js');
function makeProfile(host = 'mirror.example.test') {
  return { schemaVersion: 1, revision: host, providers: { github: {
    apiBase: `https://${host}/api/`, rawBase: `https://${host}/raw/`, downloadBase: `https://${host}/download/`,
  } } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upstream-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), zylosDir = path.join(home, 'zylos'), bin = path.join(root, 'bin');
  const configDir = path.join(zylosDir, '.zylos');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(configDir, 'components.json'), '{}');
  const profilePath = path.join(root, 'profile.json');
  fs.writeFileSync(profilePath, JSON.stringify(makeProfile()));
  const log = path.join(root, 'requests.jsonl');
  const packageRoot = path.join(root, 'package');
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), '---\nname: mirror-fixture\nversion: 2.0.0\ndescription: Isolated routing fixture\n---\n');
  fs.writeFileSync(path.join(packageRoot, 'payload.txt'), 'fixture payload\n');
  const tarball = path.join(root, 'fixture.tar.gz');
  execFileSync('tar', ['czf', tarball, '-C', root, 'package']);
  fs.writeFileSync(path.join(bin, 'curl.cjs'), `
    const fs = require('node:fs');
    const args = process.argv.slice(2), url = new URL(args.at(-1));
    const input = args.includes('@-') ? fs.readFileSync(0, 'utf8') : '';
    fs.appendFileSync(process.env.ROUTING_LOG, JSON.stringify({url: url.href, input}) + '\\n');
    const official = ['api.github.com', 'github.com', 'raw.githubusercontent.com'].includes(url.hostname);
    if (official && process.env.ALLOW_OFFICIAL !== '1') process.exit(22);
    if (!official && !['mirror.example.test', 'next.example.test'].includes(url.hostname)) process.exit(22);
    const hi = args.indexOf('-D');
    if (hi >= 0) fs.writeFileSync(args[hi + 1], 'HTTP/1.1 200 OK\\r\\n\\r\\n');
    // Exercise contents-API failure -> public raw fallback using the same profile.
    if (url.pathname.includes('/contents/')) process.exit(22);
    const oi = args.indexOf('-o');
    if (oi >= 0 && (url.pathname.includes('/archive/') || url.pathname.includes('/tarball/'))) {
      fs.copyFileSync(process.env.ROUTING_TARBALL, args[oi + 1]); process.exit(0);
    }
    if (url.pathname.endsWith('/tags')) {
      if (process.env.MUTATE_PROFILE) fs.writeFileSync(process.env.MUTATE_PROFILE, process.env.NEXT_PROFILE);
      process.stdout.write('[{"name":"v2.0.0"}]'); process.exit(0);
    }
    if (url.pathname.endsWith('/registry.json')) {
      process.stdout.write(JSON.stringify({components:{'mirror-fixture':{repo:'example/zylos-mirror-fixture',description:'Remote-only registry fixture',type:'capability'}}})); process.exit(0);
    }
    if (url.pathname.endsWith('/SKILL.md')) { process.stdout.write(fs.readFileSync(process.env.ROUTING_SKILL)); process.exit(0); }
    if (url.pathname.endsWith('/CHANGELOG.md')) { process.stdout.write('# Changelog\\n## 2.0.0\\nFixture change\\n'); process.exit(0); }
    process.exit(22);
  `);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'curl.cjs')}" "$@"\n`, { mode: 0o755 });
  // Never consult host authentication or start a real PM2 daemon in this test.
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pm2'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
  const env = {
    HOME: home, ZYLOS_DIR: zylosDir, PATH: `${bin}:${process.env.PATH}`,
    GITHUB_TOKEN: 'fixture-token-never-forward-to-custom-hosts', GH_TOKEN: '',
    ZYLOS_GH_RETRY_DELAY_MS: '', ROUTING_LOG: log, ROUTING_TARBALL: tarball,
    ROUTING_SKILL: path.join(packageRoot, 'SKILL.md'),
  };
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000,
  });
  const readLog = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const save = source => fs.writeFileSync(path.join(configDir, 'upstreams.json'), JSON.stringify({ schemaVersion: 1, source }));
  const success = result => { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); return result; };
  return { root, bin, configDir, profilePath, log, run, readLog, save, success };
}

test('CLI saved routing covers remote registry, real add pipeline, component/self checks and upgrade', t => {
  const f = fixture(t);
  f.save({ type: 'local', path: f.profilePath });
  const sourceBefore = fs.readFileSync(path.join(f.configDir, 'upstreams.json'), 'utf8');
  assert.match(f.success(f.run(['search', 'mirror-fixture'])).stdout, /Remote-only registry fixture/);
  const installed = JSON.parse(f.success(f.run(['add', 'example/zylos-mirror-fixture@1.0.0', '--json'])).stdout);
  assert.equal(installed.success, true);
  f.success(f.run(['upgrade', 'mirror-fixture', '--check', '--json']));
  f.success(f.run(['upgrade', '--self', '--check', '--json']));
  const upgraded = JSON.parse(f.success(f.run(['upgrade', 'mirror-fixture', '--yes', '--json'])).stdout);
  assert.equal(upgraded.success, true);
  assert.equal(fs.readFileSync(path.join(f.configDir, 'upstreams.json'), 'utf8'), sourceBefore);
  const requests = f.readLog();
  assert.ok(requests.some(r => r.url.includes('/raw/')));
  assert.ok(requests.some(r => r.url.includes('/api/repos/example/zylos-mirror-fixture/tags')));
  assert.ok(requests.some(r => r.url.includes('/api/repos/zylos-ai/zylos-core/tags')));
  assert.ok(requests.some(r => r.url.includes('/download/example/zylos-mirror-fixture/archive/refs/tags/')));
  for (const req of requests) {
    assert.equal(new URL(req.url).hostname, 'mirror.example.test');
    assert.equal(req.input.includes('fixture-token'), false);
  }
});

test('CLI operation freezes profile while later processes read the new local generation', t => {
  const f = fixture(t);
  f.save({ type: 'local', path: f.profilePath });
  const result = f.run(['add', 'example/zylos-mirror-fixture', '--json'], {
    MUTATE_PROFILE: f.profilePath, NEXT_PROFILE: JSON.stringify(makeProfile('next.example.test')),
  });
  assert.equal(JSON.parse(f.success(result).stdout).success, true);
  assert.ok(f.readLog().some(r => r.url.includes('/tags')));
  assert.ok(f.readLog().some(r => r.url.includes('/archive/')));
  assert.ok(f.readLog().every(r => new URL(r.url).hostname === 'mirror.example.test'));
  const diagnostic = JSON.parse(f.success(f.run(['upstream', 'status', '--resolved'])).stdout);
  assert.equal(diagnostic.endpoints.apiBase.url, 'https://next.example.test/api/');
});

test('CLI status and help do not fetch missing remote profiles; forced refresh fails', t => {
  const f = fixture(t);
  f.save({ type: 'remote', url: 'https://127.0.0.1:1/unavailable' });
  const diagnostic = JSON.parse(f.success(f.run(['upstream', 'status', '--resolved'])).stdout);
  assert.equal(diagnostic.cacheStatus, 'missing-or-invalid');
  f.success(f.run(['init', '--help']));
  f.success(f.run(['runtime']));
  assert.deepEqual(f.readLog(), []);
  assert.equal(fs.existsSync(path.join(f.configDir, 'upstreams-cache.json')), false);
  const refresh = f.run(['upstream', 'refresh']);
  assert.equal(refresh.status, 1);
  assert.match(refresh.stderr, /refresh failed/);
});

test('CLI direct baseline keeps official URLs and creates no upstream files; blocked-direct control fails', t => {
  const f = fixture(t);
  const args = ['add', 'example/zylos-mirror-fixture@1.0.0', '--json'];
  assert.notEqual(f.run(args).status, 0, 'disconnecting routing must fail when official is blocked');
  const good = f.success(f.run(args, { ALLOW_OFFICIAL: '1' }));
  assert.equal(JSON.parse(good.stdout).success, true);
  assert.equal(fs.existsSync(path.join(f.configDir, 'upstreams.json')), false);
  assert.equal(fs.existsSync(path.join(f.configDir, 'upstreams-cache.json')), false);
  assert.ok(f.readLog().every(r => ['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(new URL(r.url).hostname)));
});

test('successful CLI init persists explicit selection while unconfigured init stays diskless', t => {
  for (const configured of [false, true]) {
    const f = fixture(t);
    // Run actual init orchestration in a disposable HOME. External install,
    // runtime and service executables are inert; this is persistence wiring,
    // not deployment/runtime acceptance.
    for (const name of ['tmux', 'npm']) {
      fs.writeFileSync(path.join(f.bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    fs.writeFileSync(path.join(f.bin, 'claude'), '#!/bin/sh\nprintf \'{"loggedIn":true}\\n\'\n', { mode: 0o755 });
    const args = ['init', '--yes', '--quiet', '--runtime', 'claude', '--timezone', 'UTC', '--no-caddy'];
    if (configured) args.push('--upstream-config', f.profilePath);
    f.success(f.run(args));
    const settings = path.join(f.configDir, 'upstreams.json');
    assert.equal(fs.existsSync(settings), configured);
    assert.equal(fs.existsSync(path.join(f.configDir, 'upstreams-cache.json')), false);
    if (configured) {
      assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).source, { type: 'local', path: f.profilePath });
      assert.equal(JSON.parse(f.success(f.run(['upstream', 'status', '--resolved'])).stdout).selectedBy, 'saved');
    }
  }
});
