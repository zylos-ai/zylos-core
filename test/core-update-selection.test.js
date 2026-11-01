import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, afterEach } from '@jest/globals';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const current = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const [major, minor, patch] = current.split('-')[0].split('.').map(Number);
const next = `${major}.${minor}.${patch + 1}`;
const otherMajor = `${major + 1}.0.0`;
const cleanup = [];
afterEach(() => { for (const clean of cleanup.splice(0)) clean(); });
const tagsUrl = 'https://api.github.com/repos/zylos-ai/zylos-core/tags?per_page=100';
const tags = versions => JSON.stringify(versions.map(name => ({ name })));

function fixture(versions) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core-select-')));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
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
  ['same major', [`v${next}`], {}, next, true],
  ['mixed majors', [`v${otherMajor}`, `v${next}`, `v${current}`], {}, next, true],
  ['new major only', [`v${otherMajor}`], {}, current, false],
  ['already latest', [`v${otherMajor}`, `v${current}`], {}, current, false],
  ['stable excludes prerelease', [`v${next}-beta.1`, `v${current}`], {}, current, false],
  ['beta selects prereleases within the installed major', [`v${otherMajor}-beta.1`, `v${next}-beta.1`, `v${current}`], { beta: true }, `${next}-beta.1`, true],
]) {
  test(`core update check: ${name}`, () => {
    const f = fixture(versions);
    const result = JSON.parse(f.run(`import {checkForCoreUpdates} from './cli/lib/self-upgrade.js'; console.log(JSON.stringify(checkForCoreUpdates(${JSON.stringify(options)})));`));
    assert.deepEqual(result, { success: true, current, latest, hasUpdate });
    if (options.beta) assert.notEqual(result.latest, `${otherMajor}-beta.1`);
  });
}

// Boundary: sync CLI and async doctor selection share the real tag helper.
// Run for scoped tag/URL changes; skip for unrelated update execution changes.
test('major-scoped sync and async look beyond the first tag page', () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => `v2.0.${i}`));
  f.routes[`${tagsUrl}&page=2`] = { body: tags(['v1.9.3', 'v1.10.0', 'v0.9.4']) };
  const result = JSON.parse(f.run(`import {fetchLatestTag,fetchLatestTagAsync} from './cli/lib/github.js';
    console.log(JSON.stringify([fetchLatestTag('zylos-ai/zylos-core',{major:'0'}),await fetchLatestTagAsync('zylos-ai/zylos-core',{major:'1'}),fetchLatestTag('zylos-ai/zylos-core')]));`));
  assert.deepEqual(result, ['0.9.4', '1.10.0', '2.0.99']);
  assert.equal(f.requests().filter(url => url.endsWith('&page=2')).length, 2);
});

// Boundary: incomplete pagination must remain an error, not "up to date".
// Run for tag pagination/error changes; skip for unrelated model defaults.
test('core check reports an error when a later tag page cannot be fetched', () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => `v${major + 1}.0.${i}`));
  f.routes[`${tagsUrl}&page=2`] = { error: true };
  const result = JSON.parse(f.run(`import {checkForCoreUpdates} from './cli/lib/self-upgrade.js'; console.log(JSON.stringify(checkForCoreUpdates()));`));
  assert.equal(result.success, false);
  assert.equal(result.error, 'remote_version_failed');
});

// Boundary: explicit beta keeps its no-release error contract. Run for core
// resolution changes; skip for unrelated model/configuration changes.
test('explicit beta still reports an error when no release tags exist', () => {
  const f = fixture([]);
  const result = JSON.parse(f.run(`import {checkForCoreUpdates} from './cli/lib/self-upgrade.js'; console.log(JSON.stringify(checkForCoreUpdates({beta:true})));`));
  assert.equal(result.success, false);
  assert.equal(result.error, 'remote_version_failed');
  assert.equal(result.message, 'No release tags found');
});

// Boundary: explicit branch resolver bypasses the major restriction as before.
// Run for core target resolution changes; skip for unrelated component code.
test('explicit branch still reads and downloads a cross-major branch', () => {
  const f = fixture([]);
  f.routes['https://raw.githubusercontent.com/zylos-ai/zylos-core/next/package.json'] = { body: JSON.stringify({ version: otherMajor }) };
  f.routes['https://github.com/zylos-ai/zylos-core/archive/refs/heads/next.tar.gz'] = { file: f.archive(otherMajor) };
  f.run(null, ['upgrade', '--self', '--branch', 'next', '--yes', '--json']);
  assert.equal(JSON.parse(fs.readFileSync(f.handoff)).version, otherMajor);
  assert.ok(!f.requests().includes(tagsUrl));
});

// Boundary: real CLI check + default upgrade handoff; fixture entry only captures
// the target, never installs. Run for core selection/CLI handoff changes; skip
// when only service installation internals change.
test('default CLI check and upgrade select the same same-major archive', () => {
  const f = fixture([`v${otherMajor}`, `v${next}`]);
  f.routes[`https://github.com/zylos-ai/zylos-core/archive/refs/tags/v${next}.tar.gz`] = { file: f.archive(next) };
  const checked = JSON.parse(f.run(null, ['upgrade', '--self', '--check', '--json']));
  assert.equal(checked.latest, next);
  assert.equal(checked.hasUpdate, true);
  f.run(null, ['upgrade', '--self', '--yes', '--json']);
  const captured = JSON.parse(fs.readFileSync(f.handoff));
  assert.equal(captured.version, next);
  assert.equal(captured.handoff.fromVersion, current);
  assert.ok(!f.requests().some(url => url.includes(`v${otherMajor}.tar.gz`)));
});

// Boundary: real CLI no-update path. Run for target/check changes; skip when
// only archive extraction or service installation changes.
test('default CLI check and upgrade do not download a new major', () => {
  const f = fixture([`v${otherMajor}`]);
  for (const flags of [['--check'], ['--yes']]) {
    const result = JSON.parse(f.run(null, ['upgrade', '--self', ...flags, '--json']));
    assert.equal(result.hasUpdate, false);
    assert.equal(result.latest, current);
  }
  assert.ok(f.requests().every(url => url === tagsUrl));
  assert.equal(fs.existsSync(f.handoff), false);
});

// Boundary: release-download error cannot silently switch to main. Run for
// core download fallback changes; skip for unrelated update notifications.
test('failed release download does not fall back to main', () => {
  const f = fixture([]);
  f.routes[`https://github.com/zylos-ai/zylos-core/archive/refs/tags/v${next}.tar.gz`] = { error: true };
  const result = JSON.parse(f.run(`import {downloadCoreToTemp} from './cli/lib/self-upgrade.js'; console.log(JSON.stringify(downloadCoreToTemp('${next}')));`));
  assert.equal(result.success, false);
  assert.ok(f.requests().every(url => url.endsWith(`/v${next}.tar.gz`)));
});
