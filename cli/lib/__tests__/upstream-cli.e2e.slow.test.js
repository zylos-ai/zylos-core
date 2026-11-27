// covers: cli/lib/runtime/instruction-builder.js cli/zylos.js cli/commands/add.js cli/commands/component.js cli/commands/init.js cli/commands/runtime.js cli/lib/registry.js cli/lib/upgrade.js cli/lib/download.js cli/lib/upstreams.js cli/lib/github.js cli/lib/self-upgrade.js test/helpers/codex-trust.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { activateFreshSplitInstructions } from '../runtime/instruction-builder.js';
import { codexAppServerFixtureSource } from '../../../test/helpers/codex-trust.js';

const cli = path.resolve(import.meta.dirname, '../../zylos.js');
const coreRoot = path.resolve(import.meta.dirname, '../../..');
const installedVersion = JSON.parse(fs.readFileSync(path.join(coreRoot, 'package.json'), 'utf8')).version;
const [coreMajor, coreMinor, corePatch] = installedVersion.split('-')[0].split('.').map(Number);
const coreTargetVersion = `${coreMajor}.${coreMinor}.${corePatch + 1}`;
function makeProfile(host = 'mirror.example.test') {
  return { schemaVersion: 1, revision: host, providers: { github: {
    apiBase: `https://${host}/api/`, rawBase: `https://${host}/raw/`, downloadBase: `https://${host}/download/`,
  } } };
}
function fixture(t, { initialized = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upstream-cli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), zylosDir = path.join(home, 'zylos'), bin = path.join(root, 'bin');
  const configDir = path.join(zylosDir, '.zylos');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin);
  const pm2Home = path.join(root, 'pm2'), tmpDir = path.join(root, 'tmp');
  fs.mkdirSync(pm2Home);
  fs.mkdirSync(tmpDir);
  fs.writeFileSync(path.join(configDir, 'components.json'), '{}');
  let candidateRoot = coreRoot;
  if (initialized) {
    fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
${codexAppServerFixtureSource()}
if (process.argv[2] === '--version') console.log('codex-fixture');
else if (process.argv[2] === 'login' && process.argv[3] === 'status') console.log('Logged in using ChatGPT');
else process.exit(1);
`, { mode: 0o755 });
    // Model the installed package: development-only per-skill dependencies
    // are not part of its source payload and must not be copied by init.
    candidateRoot = path.join(root, 'core');
    fs.mkdirSync(candidateRoot);
    for (const entry of ['cli', 'skills', 'templates', 'scripts', 'package.json']) {
      fs.cpSync(path.join(coreRoot, entry), path.join(candidateRoot, entry), {
        recursive: true, filter: source => path.basename(source) !== 'node_modules',
      });
    }
    fs.symlinkSync(path.join(coreRoot, 'node_modules'), path.join(candidateRoot, 'node_modules'), 'dir');
    // Saved upstream settings imply an existing install; seed its current
    // instruction format rather than manufacturing an unmigrated legacy state.
    activateFreshSplitInstructions({ zylosDir, templatesDir: path.join(coreRoot, 'templates') });
    // npm is stubbed below, so provision dependencies for the copied skills
    // explicitly without downloading packages or consulting a host installation.
    fs.symlinkSync(path.join(coreRoot, 'node_modules'), path.join(zylosDir, 'node_modules'), 'dir');
  }
  const profilePath = path.join(root, 'profile.json');
  fs.writeFileSync(profilePath, JSON.stringify(makeProfile()));
  const log = path.join(root, 'requests.jsonl');
  const packageRoot = path.join(root, 'package');
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), '---\nname: mirror-fixture\nversion: 2.0.0\ndescription: Isolated routing fixture\n---\n');
  fs.writeFileSync(path.join(packageRoot, 'payload.txt'), 'fixture payload\n');
  const tarball = path.join(root, 'fixture.tar.gz');
  execFileSync('tar', ['czf', tarball, '-C', root, 'package']);
  // Core and components have separate release streams; keep the component's
  // cross-major fixture while Core receives a newer release in its own major.
  const corePackage = path.join(root, 'core-package');
  fs.cpSync(packageRoot, corePackage, { recursive: true });
  fs.writeFileSync(path.join(corePackage, 'package.json'), JSON.stringify({ name: 'zylos', version: coreTargetVersion, type: 'module' }));
  fs.writeFileSync(path.join(corePackage, 'CHANGELOG.md'), `# Changelog\n\n## ${coreTargetVersion}\n\nFixture core change.\n`);
  const coreTarball = path.join(root, 'core-fixture.tar.gz');
  execFileSync('tar', ['czf', coreTarball, '-C', root, 'core-package']);
  fs.writeFileSync(path.join(bin, 'curl.cjs'), `
    const fs = require('node:fs');
    const args = process.argv.slice(2), url = new URL(args.at(-1));
    const input = args.includes('@-') ? fs.readFileSync(0, 'utf8') : '';
    fs.appendFileSync(process.env.ROUTING_LOG, JSON.stringify({url: url.href, input}) + '\\n');
    if (url.href === 'https://config.example.test/profile.json') {
      process.stdout.write('HTTP/1.1 200 OK\\r\\nETag: fixture-profile\\r\\n\\r\\n' + fs.readFileSync(process.env.ROUTING_PROFILE)); process.exit(0);
    }
    const official = ['api.github.com', 'github.com', 'raw.githubusercontent.com'].includes(url.hostname);
    if (official && process.env.ALLOW_OFFICIAL !== '1') process.exit(22);
    if (!official && !['mirror.example.test', 'next.example.test'].includes(url.hostname)) process.exit(22);
    const hi = args.indexOf('-D');
    if (hi >= 0) fs.writeFileSync(args[hi + 1], 'HTTP/1.1 200 OK\\r\\n\\r\\n');
    // Exercise contents-API failure -> public raw fallback using the same profile.
    if (url.pathname.includes('/contents/')) process.exit(22);
    const oi = args.indexOf('-o');
    if (oi >= 0 && (url.pathname.includes('/archive/') || url.pathname.includes('/tarball/'))) {
      fs.copyFileSync(url.pathname.includes('/zylos-ai/zylos-core/') ? process.env.ROUTING_CORE_TARBALL : process.env.ROUTING_TARBALL, args[oi + 1]); process.exit(0);
    }
    if (url.pathname.endsWith('/tags')) {
      if (process.env.MUTATE_PROFILE) fs.writeFileSync(process.env.MUTATE_PROFILE, process.env.NEXT_PROFILE);
      process.stdout.write(JSON.stringify([{ name: 'v' + (url.pathname.includes('/zylos-ai/zylos-core/') ? process.env.ROUTING_CORE_VERSION : '2.0.0') }])); process.exit(0);
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
  for (const name of ['npm', 'tmux', 'git']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  const env = {
    HOME: home, ZYLOS_DIR: zylosDir, PATH: `${bin}:${process.env.PATH}`,
    PM2_HOME: pm2Home, TMPDIR: tmpDir,
    ZYLOS_PACKAGE_ROOT: candidateRoot,
    GITHUB_TOKEN: 'fixture-token-never-forward-to-custom-hosts', GH_TOKEN: '',
    ZYLOS_GH_RETRY_DELAY_MS: '', ROUTING_LOG: log, ROUTING_TARBALL: tarball,
    ROUTING_CORE_TARBALL: coreTarball, ROUTING_CORE_VERSION: coreTargetVersion,
    ROUTING_SKILL: path.join(packageRoot, 'SKILL.md'), ROUTING_PROFILE: profilePath,
  };
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [initialized ? path.join(candidateRoot, 'cli/zylos.js') : cli, ...args], {
    cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000,
  });
  const readLog = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const save = source => fs.writeFileSync(path.join(configDir, 'upstreams.json'), JSON.stringify({ schemaVersion: 1, source }));
  const success = result => {
    const diagnostic = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/^.*Password:.*$/gm, '[fixture password omitted]');
    assert.equal(result.status, 0, diagnostic);
    return result;
  };
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, zylosDir, candidateRoot, bin, configDir, profilePath, log, run, readLog, save, success, cleanup };
}

// Boundary: routing through registry, component cross-major updates and Core
// same-major archives. Run for routing/target changes; skip for unrelated services.
test('CLI saved routing covers remote registry, real add pipeline, component/self checks and upgrade', t => {
  const f = fixture(t);
  f.save({ type: 'local', path: f.profilePath });
  const sourceBefore = fs.readFileSync(path.join(f.configDir, 'upstreams.json'), 'utf8');
  assert.match(f.success(f.run(['search', 'mirror-fixture'])).stdout, /Remote-only registry fixture/);
  const installed = JSON.parse(f.success(f.run(['add', 'example/zylos-mirror-fixture@1.0.0', '--json'])).stdout);
  assert.equal(installed.success, true);
  const componentCheck = JSON.parse(f.success(f.run(['upgrade', 'mirror-fixture', '--check', '--json'])).stdout);
  assert.equal(componentCheck.latest, '2.0.0');
  const coreCheck = JSON.parse(f.success(f.run(['upgrade', '--self', '--check', '--json'])).stdout);
  assert.equal(coreCheck.latest, coreTargetVersion);
  assert.equal(coreCheck.hasUpdate, true);
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

test('CLI rejects invalid and removed sources before doing any network work', t => {
  const f = fixture(t);
  for (const value of ['http://config.test/p', 'ftp://config.test/p', 'file:///tmp/p', 'https://', '']) {
    for (const result of [f.run(['upstream', 'status', '--upstream-config', value]), f.run(['upstream', 'status'], { ZYLOS_UPSTREAM_CONFIG: value })]) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /require|Invalid upstream URL/);
    }
  }
  for (const flag of ['--upstream-profile', '--upstream-config-url']) {
    const result = f.run(['upstream', 'status', flag, 'direct']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown upstream option/);
  }
  for (const key of ['ZYLOS_UPSTREAM_PROFILE', 'ZYLOS_UPSTREAM_CONFIG_URL']) {
    const result = f.run(['upstream', 'status'], { [key]: '' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /has been removed/);
  }
  fs.writeFileSync(path.join(f.configDir, 'upstreams.json'), JSON.stringify({ schemaVersion: 1, source: { type: 'direct' }, overrides: {} }));
  const stale = f.run(['upstream', 'status', '--upstream-config', 'direct']);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /overrides are not supported.*local profile/);
  assert.deepEqual(f.readLog(), []);
});
