import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '..');
const tagsUrl = 'https://api.github.com/repos/zylos-ai/zylos-core/tags?per_page=100';
const tags = versions => JSON.stringify(versions.map(name => ({ name })));

function fixture(t, versions) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core-select-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  for (const dir of ['bin', 'home', 'zylos', 'pm2', 'tmp']) fs.mkdirSync(path.join(root, dir));
  const routesFile = path.join(root, 'routes.json');
  const log = path.join(root, 'requests.jsonl');
  const handoff = path.join(root, 'handoff.json');
  const routes = { [tagsUrl]: { body: tags(versions) } };
  const env = {
    ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'),
    TMUX: '', TMUX_TMPDIR: path.join(root, 'tmp'),
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    GITHUB_TOKEN: '', GH_TOKEN: '', ZYLOS_GH_RETRY_DELAY_MS: '',
    CORE_SELECTION_HANDOFF: handoff,
  };
  // No service or installer command may escape to the host. No tmux or database
  // is needed: this boundary stops at a fixture upgrade entry, before installation.
  for (const name of ['gh', 'git', 'npm', 'pm2', 'tmux', 'zylos']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), url = args.at(-1);
fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(url)+'\\n');
const response = JSON.parse(fs.readFileSync(${JSON.stringify(routesFile)}, 'utf8'))[url];
if (!response) { console.error('Unexpected request: '+url); process.exit(97); }
if (response.error) { console.error('curl: (22) The requested URL returned error: 404'); process.exit(22); }
if (args.includes('-o')) {
  const output = args[args.indexOf('-o')+1];
  if (response.file) fs.copyFileSync(response.file, output);
  else fs.writeFileSync(output, response.body || '');
} else process.stdout.write(response.body || '');
`, { mode: 0o755 });
  const save = () => fs.writeFileSync(routesFile, JSON.stringify(routes));
  function run(code, args = []) {
    save();
    // Read back actual isolation targets before each child; stdout is test evidence.
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
      assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep), key);
    }
    console.log(JSON.stringify({ isolation: root, HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR,
      PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, tmux: 'blocked; unused', databases: 'unused' }));
    const child = spawnSync(process.execPath, [...(code ? ['--input-type=module', '-e', code] : ['cli/zylos.js']), ...args],
      { cwd: repo, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return child.stdout;
  }
  function archive(version) {
    const source = path.join(root, 'archive-source');
    fs.mkdirSync(path.join(source, 'cli/lib'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version, type: 'module' }));
    fs.writeFileSync(path.join(source, 'cli/lib/upgrade-entry.js'),
      "import fs from 'node:fs'; fs.writeFileSync(process.env.CORE_SELECTION_HANDOFF, JSON.stringify({version:JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url))).version,handoff:JSON.parse(fs.readFileSync(0,'utf8'))}));");
    const tarball = path.join(root, 'fixture.tar.gz');
    const packed = spawnSync('/usr/bin/tar', ['-czf', tarball, '-C', root, 'archive-source']);
    assert.equal(packed.status, 0, packed.stderr?.toString());
    return tarball;
  }
  return { root, routes, run, archive, handoff,
    requests: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

// Boundary: real core resolver + GitHub transport. Run when tag selection,
// pagination, prerelease handling or core defaults change; skip for unrelated code.
for (const [name, versions, options, latest, hasUpdate] of [
  ['same major', ['v0.9.4'], {}, '0.9.4', true],
  ['mixed majors', ['v1.0.0', 'v0.9.4', 'v0.9.2'], {}, '0.9.4', true],
  ['new major only', ['v1.0.0'], {}, '0.9.3', false],
  ['already latest', ['v1.0.0', 'v0.9.3', 'v0.9.2'], {}, '0.9.3', false],
  ['stable excludes prerelease', ['v0.9.4-beta.1', 'v0.9.3'], {}, '0.9.3', false],
  ['explicit beta keeps unscoped prerelease selection', ['v1.0.0-beta.1', 'v0.9.4-beta.1', 'v0.9.3'], { beta: true }, '1.0.0-beta.1', true],
]) {
  test(`core update check: ${name}`, t => {
    const f = fixture(t, versions);
    const result = JSON.parse(f.run(`import {checkForCoreUpdates} from './cli/lib/self-upgrade.js'; console.log(JSON.stringify(checkForCoreUpdates(${JSON.stringify(options)})));`));
    assert.deepEqual(result, { success: true, current: '0.9.3', latest, hasUpdate });
  });
}

// Boundary: sync CLI and async doctor selection share the real tag helper.
// Run for scoped tag/URL changes; skip for unrelated update execution changes.
test('major-scoped sync and async look beyond the first tag page', t => {
  const f = fixture(t, Array.from({ length: 100 }, (_, i) => `v2.0.${i}`));
  f.routes[`${tagsUrl}&page=2`] = { body: tags(['v1.9.3', 'v1.10.0', 'v0.9.4']) };
  const result = JSON.parse(f.run(`import {fetchLatestTag,fetchLatestTagAsync} from './cli/lib/github.js';
    console.log(JSON.stringify([fetchLatestTag('zylos-ai/zylos-core',{major:'0'}),await fetchLatestTagAsync('zylos-ai/zylos-core',{major:'1'}),fetchLatestTag('zylos-ai/zylos-core')]));`));
  assert.deepEqual(result, ['0.9.4', '1.10.0', '2.0.99']);
  assert.equal(f.requests().filter(url => url.endsWith('&page=2')).length, 2);
});

// Boundary: incomplete pagination must remain an error, not "up to date".
// Run for tag pagination/error changes; skip for unrelated model defaults.
test('core check reports an error when a later tag page cannot be fetched', t => {
  const f = fixture(t, Array.from({ length: 100 }, (_, i) => `v1.0.${i}`));
  f.routes[`${tagsUrl}&page=2`] = { error: true };
  const result = JSON.parse(f.run(`import {checkForCoreUpdates} from './cli/lib/self-upgrade.js'; console.log(JSON.stringify(checkForCoreUpdates()));`));
  assert.equal(result.success, false);
  assert.equal(result.error, 'remote_version_failed');
});

// Boundary: explicit beta keeps its no-release error contract. Run for core
// resolution changes; skip for unrelated model/configuration changes.
test('explicit beta still reports an error when no release tags exist', t => {
  const f = fixture(t, []);
  const result = JSON.parse(f.run(`import {checkForCoreUpdates} from './cli/lib/self-upgrade.js'; console.log(JSON.stringify(checkForCoreUpdates({beta:true})));`));
  assert.equal(result.success, false);
  assert.equal(result.error, 'remote_version_failed');
  assert.equal(result.message, 'No release tags found');
});

// Boundary: explicit branch resolver bypasses the major restriction as before.
// Run for core target resolution changes; skip for unrelated component code.
test('explicit branch still reads and downloads a cross-major branch', t => {
  const f = fixture(t, []);
  f.routes['https://raw.githubusercontent.com/zylos-ai/zylos-core/next/package.json'] = { body: '{"version":"1.0.0"}' };
  f.routes['https://github.com/zylos-ai/zylos-core/archive/refs/heads/next.tar.gz'] = { file: f.archive('1.0.0') };
  f.run(null, ['upgrade', '--self', '--branch', 'next', '--yes', '--json']);
  assert.equal(JSON.parse(fs.readFileSync(f.handoff)).version, '1.0.0');
  assert.ok(!f.requests().includes(tagsUrl));
});

// Boundary: real CLI check + default upgrade handoff; fixture entry only captures
// the target, never installs. Run for core selection/CLI handoff changes; skip
// when only service installation internals change.
test('default CLI check and upgrade select the same same-major archive', t => {
  const f = fixture(t, ['v1.0.0', 'v0.9.4']);
  f.routes['https://github.com/zylos-ai/zylos-core/archive/refs/tags/v0.9.4.tar.gz'] = { file: f.archive('0.9.4') };
  const checked = JSON.parse(f.run(null, ['upgrade', '--self', '--check', '--json']));
  assert.equal(checked.latest, '0.9.4');
  assert.equal(checked.hasUpdate, true);
  f.run(null, ['upgrade', '--self', '--yes', '--json']);
  const captured = JSON.parse(fs.readFileSync(f.handoff));
  assert.equal(captured.version, '0.9.4');
  assert.equal(captured.handoff.fromVersion, '0.9.3');
  assert.ok(!f.requests().some(url => url.includes('v1.0.0.tar.gz')));
});

// Boundary: real CLI no-update path. Run for target/check changes; skip when
// only archive extraction or service installation changes.
test('default CLI check and upgrade do not download a new major', t => {
  const f = fixture(t, ['v1.0.0']);
  for (const flags of [['--check'], ['--yes']]) {
    const result = JSON.parse(f.run(null, ['upgrade', '--self', ...flags, '--json']));
    assert.equal(result.hasUpdate, false);
    assert.equal(result.latest, '0.9.3');
  }
  assert.ok(f.requests().every(url => url === tagsUrl));
  assert.equal(fs.existsSync(f.handoff), false);
});

// Boundary: release-download error cannot silently switch to main. Run for
// core download fallback changes; skip for unrelated update notifications.
test('failed release download does not fall back to main', t => {
  const f = fixture(t, []);
  f.routes['https://github.com/zylos-ai/zylos-core/archive/refs/tags/v0.9.4.tar.gz'] = { error: true };
  const result = JSON.parse(f.run(`import {downloadCoreToTemp} from './cli/lib/self-upgrade.js'; console.log(JSON.stringify(downloadCoreToTemp('0.9.4')));`));
  assert.equal(result.success, false);
  assert.ok(f.requests().every(url => url.endsWith('/v0.9.4.tar.gz')));
});
