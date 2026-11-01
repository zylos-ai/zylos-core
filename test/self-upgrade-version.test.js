import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'cli/zylos.js');
const CURRENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const DATABASE_CONTENT = 'isolated version-selection database sentinel\n';

// These tests exercise the real CLI across its version selector, GitHub client,
// archive downloader and target handoff. Only external commands and downloaded
// target/recovery materials are fixtures; installed product sources stay intact.
function fixture(t, { pages = [[]], target = '1.0.0', downloadFails = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suv-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const zylos = path.join(root, 'zylos');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  const pm2 = path.join(root, 'pm2');
  const tmux = path.join(root, 'tmux');
  for (const dir of [home, zylos, bin, tmp, pm2, tmux]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  const callsFile = path.join(root, 'commands.jsonl');
  const handoffFile = path.join(root, 'handoff.json');
  const recoveryFile = path.join(root, 'recovery.jsonl');
  const databases = ['comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db']
    .map(relative => path.join(zylos, relative));
  for (const file of databases) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, DATABASE_CONTENT);
  }
  const stable = path.join(zylos, '.zylos/upgrade');
  fs.mkdirSync(stable, { recursive: true });
  fs.mkdirSync(path.join(zylos, '.backup/self-upgrade'), { recursive: true });
  fs.writeFileSync(path.join(stable, 'maintenance.cjs'), "'use strict';\n");
  fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), `
    const fs = require('node:fs');
    exports.bootstrap = (root, options) => {
      fs.appendFileSync(${JSON.stringify(recoveryFile)}, JSON.stringify({root, options})+'\\n');
      return {active:false, blocked:false};
    };
  `);

  const source = path.join(root, 'archive/package');
  fs.mkdirSync(path.join(source, 'cli/lib'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'zylos', version: target, type: 'module' }));
  fs.writeFileSync(path.join(source, 'cli/lib/upgrade-entry.js'), `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(handoffFile)}, fs.readFileSync(0, 'utf8'));
    process.stdout.write('isolated target entry\\n');
  `);
  const archive = path.join(root, 'target.tar.gz');
  execFileSync('/usr/bin/tar', ['czf', archive, '-C', path.dirname(source), 'package']);
  const routes = path.join(root, 'routes.json');
  fs.writeFileSync(routes, JSON.stringify({ pages, target, archive, downloadFails }));
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2), url = args.at(-1);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({command:'curl',args})+'\\n');
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routes)},'utf8'));
const parsed = new URL(url);
if (parsed.origin === 'https://api.github.com' && parsed.pathname === '/repos/zylos-ai/zylos-core/tags') {
  const page = Number(parsed.searchParams.get('page') || 1);
  process.stdout.write(JSON.stringify(routes.pages[page-1] || []));
} else if (url === 'https://github.com/zylos-ai/zylos-core/archive/refs/tags/v'+routes.target+'.tar.gz') {
  if (routes.downloadFails) { console.error('curl: (22) The requested URL returned error: 404'); process.exit(22); }
  const index = args.indexOf('-o');
  if (index < 0) process.exit(97);
  fs.copyFileSync(routes.archive,args[index+1]);
} else { console.error('Unexpected fixture request: '+url); process.exit(98); }
`, { mode: 0o755 });
  for (const command of ['gh', 'pm2', 'tmux', 'npm', 'git', 'ssh', 'ps']) {
    fs.writeFileSync(path.join(bin, command), `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2)})+'\\n');
process.exit(99);
`, { mode: 0o755 });
  }
  fs.symlinkSync('/usr/bin/tar', path.join(bin, 'tar'));
  fs.symlinkSync('/usr/bin/gzip', path.join(bin, 'gzip'));
  const env = {
    HOME: home,
    ZYLOS_DIR: zylos,
    PM2_HOME: pm2,
    TMPDIR: tmp,
    TMUX_TMPDIR: tmux,
    TMUX: `${path.join(tmux, 'private.sock')},0,0`,
    PATH: bin,
    LANG: 'C',
    TZ: 'UTC',
    ZYLOS_UPSTREAM_CONFIG: 'direct',
    ZYLOS_UPSTREAM_TRUST_HOSTS: 'none',
    ZYLOS_GH_RETRY_DELAY_MS: '0,0',
  };
  const calls = () => fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const run = args => {
    for (const value of [home, zylos, pm2, tmp, tmux, ...databases]) {
      assert.ok(fs.realpathSync(value).startsWith(root + path.sep), value);
    }
    assert.equal(env.PATH, bin);
    for (const command of ['curl', 'gh', 'pm2', 'tmux', 'npm']) {
      assert.ok(fs.realpathSync(path.join(bin, command)).startsWith(root + path.sep));
    }
    // Report actual arguments and isolated destinations before each CLI process.
    t.diagnostic(JSON.stringify({ args, env, databases }));
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null);
    for (const file of databases) assert.equal(fs.readFileSync(file, 'utf8'), DATABASE_CONTENT);
    const dangerous = calls().filter(call => !['gh', 'curl'].includes(call.command));
    assert.deepEqual(dangerous, [], 'service/install commands must stay unused');
    return result;
  };
  return {
    run, calls, handoffFile,
    recoveryCalls: () => fs.existsSync(recoveryFile) ? fs.readFileSync(recoveryFile, 'utf8') : '',
  };
}

function parsed(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function assertNoWork(f) {
  assert.equal(f.recoveryCalls(), '');
  assert.equal(fs.existsSync(f.handoffFile), false);
  assert.equal(f.calls().filter(call => call.command === 'curl').length, 0);
}

// Boundary: top-level version dispatch vs upgrade's value flag. Run when CLI
// dispatch/help changes; skip for unrelated upgrade execution/recovery changes.
test('top-level version prints installed version and help distinguishes the target option', t => {
  const f = fixture(t);
  for (const flag of ['--version', '-v']) {
    const result = f.run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), CURRENT);
  }
  const help = f.run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--version/);
  assert.match(help.stdout, /upgrade --self/);
  assertNoWork(f);
});

const invalidArguments = [
  ['--self', '--version=1.0.0'],
  ['--self', '--version'],
  ['--self', '--version', '--check'],
  ['--self', '--version', '1.0.0', '--version', '1.1.0'],
  ['--self', '--version', '1.0.0', '--beta'],
  ['--self', '--version', '1.0.0', '--branch', 'main'],
  ['--version', '1.0.0', 'telegram'],
  ['--all', '--version', '1.0.0'],
  ['--self', '--all', '--version', '1.0.0'],
  ['--self', 'telegram', '--version', '1.0.0'],
];
for (const args of invalidArguments) {
  // Boundary: argument admission before selection/recovery. Run when upgrade
  // parsing changes; skip for finalizer, service or database-only changes.
  test(`invalid target option combination is rejected: ${args.join(' ')}`, t => {
    const f = fixture(t);
    const result = f.run(['upgrade', ...args, '--yes']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /--version/);
    assertNoWork(f);
  });
}

for (const version of ['v1.0.0', '1.0', '01.0.0', '1.0.0-beta.01', '^1.0.0', 'main']) {
  // Boundary: strict explicit SemVer input, including actionable v-prefix error.
  // Run when version parsing changes; skip for unrelated upgrade stages.
  test(`invalid explicit version is rejected before recovery: ${version}`, t => {
    const f = fixture(t);
    const result = f.run(['upgrade', '--self', '--version', version, '--yes']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr + result.stdout, /version|SemVer/i);
    if (version.startsWith('v')) assert.match(result.stderr + result.stdout, /--version 1\.0\.0/);
    assertNoWork(f);
  });
}

for (const check of [false, true]) {
  // Boundary: explicit downgrade/equality precedence before deployed recovery.
  // Run when explicit selection or check/upgrade ordering changes; skip for
  // target-package internals, since the target entry never runs here.
  test(`lower explicit targets fail and equal targets do no work${check ? ' in check mode' : ''}`, t => {
    const f = fixture(t);
    const tail = check ? ['--check'] : ['--yes'];
    for (const version of ['0.0.0', `${CURRENT}-beta.1`]) {
      const lower = f.run(['upgrade', '--self', '--version', version, ...tail]);
      assert.equal(lower.status, 1, lower.stdout + lower.stderr);
      assert.match(lower.stdout + lower.stderr, /downgrade|lower|older/i);
    }
    for (const version of [CURRENT, `${CURRENT}+local`]) {
      const equal = f.run(['upgrade', '--self', '--version', version, ...tail]);
      assert.equal(equal.status, 0, equal.stdout + equal.stderr);
      assert.match(equal.stdout, /already|up to date/i);
    }
    assertNoWork(f);
  });
}

for (const target of ['1.0.0', '1.0.0-beta.1', '1.0.0+build.1']) {
  // Boundary: explicit stable/prerelease/build targets cross major by exact tag,
  // and --check reports only version/tag eligibility. Run when selection/check
  // output changes; skip for target execution or finalization-only changes.
  test(`explicit check accepts an exact target tag without executing: ${target}`, t => {
    const f = fixture(t, { target, pages: [[{ name: `v${target}` }]] });
    const result = f.run(['upgrade', '--self', '--check', '--version', target, '--json']);
    const output = parsed(result);
    assert.equal(output.current, CURRENT);
    assert.equal(output.latest, target);
    assert.equal(output.hasUpdate, true);
    assert.match(JSON.stringify(output), /version.*tag|tag.*version/i);
    assert.match(JSON.stringify(output), /target.*entry|target.*accept|starting.*version/i);
    const plain = f.run(['upgrade', '--self', '--check', '--version', target]);
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.match(plain.stdout, /version.*tag|tag.*version/i);
    assert.match(plain.stdout, /target.*entry|target.*accept|starting.*version/i);
    assert.equal(f.recoveryCalls(), '');
    assert.equal(fs.existsSync(f.handoffFile), false);
    assert.ok(f.calls().filter(call => call.command === 'curl')
      .every(call => new URL(call.args.at(-1)).pathname.endsWith('/tags')));
  });
}

for (const tags of [[{ name: '1.0.0' }], [{ name: 'v1.0.0-beta.1' }], []]) {
  // Boundary: missing exact v-prefixed tag, even when unprefixed/similar names
  // exist. Run when exact tag lookup changes; skip for target internals.
  test(`explicit missing tag is rejected without branch fallback: ${JSON.stringify(tags)}`, t => {
    const f = fixture(t, { pages: [tags] });
    const result = f.run(['upgrade', '--self', '--check', '--version', '1.0.0', '--json']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /tag.*v1\.0\.0|v1\.0\.0.*tag/i);
    assert.equal(f.recoveryCalls(), '');
    assert.equal(fs.existsSync(f.handoffFile), false);
    assert.ok(f.calls().filter(call => call.command === 'curl')
      .every(call => new URL(call.args.at(-1)).pathname.endsWith('/tags')));
  });
}

// Boundary: exact target tag on later GitHub tag page. Run when tags pagination
// or explicit selection changes; skip for target execution-only changes.
test('explicit tag lookup continues beyond the first page', t => {
  const first = Array.from({ length: 100 }, (_, i) => ({ name: `v2.0.${i}` }));
  const f = fixture(t, { pages: [first, [{ name: 'v1.0.0' }]] });
  const output = parsed(f.run(['upgrade', '--self', '--check', '--version', '1.0.0', '--json']));
  assert.equal(output.latest, '1.0.0');
  assert.ok(f.calls().some(call => call.command === 'curl' && call.args.at(-1).endsWith('&page=2')));
  assert.equal(f.recoveryCalls(), '');
});

for (const beta of [false, true]) {
  // Boundary: default/beta current-major selection across paginated tags.
  // Run when release selection changes; skip for finalizer/recovery-only changes.
  test(`${beta ? 'beta' : 'stable'} selection stays in the installed major across pages`, t => {
    const target = beta ? '0.99.1-beta.2' : '0.99.0';
    const first = Array.from({ length: 100 }, (_, i) => ({ name: `v1.0.${i}` }));
    const f = fixture(t, {
      target,
      pages: [first, [{ name: 'v0.99.1-beta.2' }, { name: 'v0.99.0' }]],
    });
    const output = parsed(f.run(['upgrade', '--self', '--check', '--json', ...(beta ? ['--beta'] : [])]));
    assert.equal(output.latest, target);
    assert.equal(output.hasUpdate, true);
    assert.ok(f.calls().some(call => call.command === 'curl' && call.args.at(-1).endsWith('&page=2')));
    assert.doesNotMatch(output.reply, /1\.0\./);
    assert.equal(f.recoveryCalls(), '');
    assert.equal(fs.existsSync(f.handoffFile), false);
  });
}

// Boundary: no current-major stable candidate; higher major is never advertised.
// Run when default tag filtering changes; skip for execution-only changes.
test('stable check with only a newer major reports the current version', t => {
  const f = fixture(t, { pages: [[{ name: 'v1.0.0' }]] });
  const output = parsed(f.run(['upgrade', '--self', '--check', '--json']));
  assert.equal(output.latest, CURRENT);
  assert.equal(output.hasUpdate, false);
  assert.doesNotMatch(output.reply, /1\.0\.0/);
});

// Boundary: beta lookup has no candidate in the installed major. Run when beta
// filtering changes; skip for execution-only changes. An empty result is not a
// reason to advertise a release from another major.
test('beta check with only a newer major reports no matching release', t => {
  const f = fixture(t, { pages: [[{ name: 'v1.0.0-beta.1' }, { name: 'v1.0.0' }]] });
  const result = f.run(['upgrade', '--self', '--check', '--beta', '--json']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /No release tags found/);
  assert.doesNotMatch(result.stdout, /1\.0\.0/);
  assert.equal(f.recoveryCalls(), '');
  assert.equal(fs.existsSync(f.handoffFile), false);
});

// Boundary: exact release archive and existing target-owned JSON handoff.
// Run when explicit selection/download/handoff wiring changes; skip for real
// installation/finalizer tests, which this inert target does not cover.
test('explicit upgrade downloads the exact tag and hands off to its entry', t => {
  const f = fixture(t, { pages: [[{ name: 'v1.0.0' }]] });
  const result = f.run(['upgrade', '--self', '--version', '1.0.0', '--yes']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /isolated target entry/);
  assert.notEqual(f.recoveryCalls(), '');
  const handoff = JSON.parse(fs.readFileSync(f.handoffFile, 'utf8'));
  assert.equal(handoff.fromVersion, CURRENT);
  assert.equal(handoff.installedRoot, ROOT);
  assert.ok(handoff.tempDir.includes('/tmp/zylos-self-upgrade-'));
  const archives = f.calls().filter(call => call.command === 'curl' && call.args.at(-1).includes('/archive/'));
  assert.equal(archives.length, 1);
  assert.equal(archives[0].args.at(-1), 'https://github.com/zylos-ai/zylos-core/archive/refs/tags/v1.0.0.tar.gz');
});

// Boundary: a failed exact archive download never selects a branch. Run when
// selection/download wiring changes; skip for target-package execution changes.
test('explicit archive failure does not fall back to a branch or execute a target', t => {
  const f = fixture(t, { pages: [[{ name: 'v1.0.0' }]], downloadFails: true });
  const result = f.run(['upgrade', '--self', '--version', '1.0.0', '--yes']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(fs.existsSync(f.handoffFile), false);
  assert.ok(f.calls().filter(call => call.command === 'curl')
    .every(call => !call.args.at(-1).includes('/heads/') && !call.args.at(-1).includes('/tarball/main')));
});

// Boundary: non-check upgrade rejects a missing exact tag after recovery without
// downloading or handing off. Run for explicit selection or admission ordering
// changes; skip for real installation/finalizer-only changes.
test('explicit upgrade with a missing tag never downloads or executes a target', t => {
  const f = fixture(t, { pages: [[{ name: '1.0.0' }]] });
  const result = f.run(['upgrade', '--self', '--version', '1.0.0', '--yes']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /tag.*v1\.0\.0|v1\.0\.0.*tag/i);
  assert.equal(fs.existsSync(f.handoffFile), false);
  assert.ok(f.calls().filter(call => call.command === 'curl')
    .every(call => new URL(call.args.at(-1)).pathname.endsWith('/tags')));
});
