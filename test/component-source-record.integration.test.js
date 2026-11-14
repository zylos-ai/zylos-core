// What components.json records as a component's source after `zylos add` and `zylos upgrade`.
//
// Coverage: the real CLI (`cli/zylos.js add|upgrade`) installing and upgrading a component from a fake GitHub. A
// stub `curl` serves the tag list and archives made with real `git archive` from a throwaway repository, so the
// commit ids the record must name are real ones. Run it when the download, install or upgrade code changes, or the
// record written to components.json does; it can be skipped for changes that touch none of cli/commands/add.js,
// cli/commands/component.js (upgrade), cli/lib/download.js, cli/lib/upgrade.js or cli/lib/components.js.
// It does not cover AI-mode installs (no SKILL.md), which hand setup to a live agent; those write the record through
// the same recordedSource call. It reaches no network and no live install: every run gets its own HOME,
// ZYLOS_DIR, PM2_HOME and TMPDIR under a fresh temporary directory, PATH starts with stubs for curl, gh, pm2, npm
// and tmux, and the whole directory is removed after each test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { after, afterEach, before, describe, it } from 'node:test';

const CLI = path.join(import.meta.dirname, '..', 'cli', 'zylos.js');
const NAME = 'src-record';
const REPO = `example/zylos-${NAME}`;
const CLI_TIMEOUT_MS = 60000;

let upstream;
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function skillMd(version, extra = '') {
  return `---\nname: ${NAME}\nversion: ${version}\ndescription: Source record E2E fixture\n${extra}---\n\n# Fixture\n`;
}

// A throwaway repository with release tags, a feature branch and a main branch that has moved past the releases.
// Every ref gets a GitHub-style archive made by `git archive`, which names its commit in the pax header.
function buildUpstream() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-source-record-upstream-'));
  const repo = path.join(root, 'repo');
  const archives = path.join(root, 'archives');
  fs.mkdirSync(repo);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  const commit = (version, files = {}) => {
    fs.writeFileSync(path.join(repo, 'SKILL.md'), skillMd(version));
    fs.writeFileSync(path.join(repo, 'payload.txt'), `payload ${version}\n`);
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), content);
    git('add', '-A');
    git('commit', '-q', '-m', version);
  };

  git('init', '-q', '-b', 'main');
  commit('1.0.0');
  git('tag', 'v1.0.0');
  commit('2.0.0');
  git('tag', 'v2.0.0');
  git('checkout', '-q', '-b', 'feat/x');
  commit('2.0.1');
  git('checkout', '-q', 'main');
  commit('2.1.0-beta.1');
  git('tag', 'v2.1.0-beta.1');
  commit('2.2.0');
  git('checkout', '-q', '-b', 'release-2.3', 'v2.0.0');
  commit('2.3.0');
  git('tag', 'v2.3.0');
  // A release that cannot install: npm (stubbed) fails, so the upgrade rolls back.
  git('checkout', '-q', '-b', 'release-3', 'v2.0.0');
  commit('3.0.0', { 'package.json': `${JSON.stringify({ name: NAME, version: '3.0.0' })}\n` });
  git('tag', 'v3.0.0');
  git('checkout', '-q', 'main');

  const refs = { tags: ['v1.0.0', 'v2.0.0', 'v2.1.0-beta.1', 'v2.3.0', 'v3.0.0'], heads: ['main', 'feat/x'] };
  const commits = {};
  for (const [kind, names] of Object.entries(refs)) {
    for (const name of names) {
      const file = path.join(archives, kind, `${name}.tar.gz`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      git('archive', '--format=tar.gz', `--prefix=zylos-${NAME}-${name.replace(/^v/, '').replace('/', '-')}/`, '-o', file, name);
      commits[name] = git('rev-parse', `${name}^{commit}`);
    }
  }
  return { root, archives, commits };
}

before(() => { upstream = buildUpstream(); });
after(() => { if (upstream) fs.rmSync(upstream.root, { recursive: true, force: true }); });

function makeHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-source-record-e2e-'));
  tmpDirs.push(root);
  const home = path.join(root, 'home');
  const zylosDir = path.join(home, 'zylos');
  const bin = path.join(root, 'bin');
  const pm2Home = path.join(root, 'pm2');
  const tmp = path.join(root, 'tmp');
  const curlLog = path.join(root, 'curl.log');
  for (const dir of [path.join(zylosDir, '.zylos'), bin, pm2Home, tmp]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'components.json'), '{}\n');

  // GitHub: the tag list (FAKE_TAGS) and the archives built above; anything else is a 404.
  fs.writeFileSync(path.join(bin, 'curl.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const url = new URL(args.at(-1));
fs.appendFileSync(process.env.FAKE_CURL_LOG, url.href + '\\n');
const output = args.indexOf('-o') === -1 ? null : args[args.indexOf('-o') + 1];
const prefix = '/' + process.env.FAKE_REPO;
if (url.pathname === '/repos' + prefix + '/tags') {
  const page = Number(url.searchParams.get('page') || 1);
  const tags = page === 1 ? process.env.FAKE_TAGS.split(',').filter(Boolean).map(name => ({ name })) : [];
  process.stdout.write(JSON.stringify(tags));
  process.exit(0);
}
const archive = url.pathname.startsWith(prefix + '/archive/refs/') && url.pathname.endsWith('.tar.gz')
  ? url.pathname.slice((prefix + '/archive/refs/').length, -'.tar.gz'.length).split('/').map(decodeURIComponent).join('/')
  : null;
const file = archive && path.join(process.env.FAKE_ARCHIVES, archive + '.tar.gz');
if (file && output && !process.env.FAKE_MISSING.split(',').includes(archive) && fs.existsSync(file)) {
  fs.copyFileSync(file, output);
  process.exit(0);
}
process.stderr.write('curl: (22) The requested URL returned error: 404\\n');
process.exit(22);
`);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/curl.mjs" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pm2'), '#!/bin/sh\n[ "$1" = jlist ] && { echo "[]"; exit 0; }\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "npm stub refuses" >&2\nexit 97\n', { mode: 0o755 });
  for (const tool of ['gh', 'tmux']) fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const env = {
    PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: home,
    ZYLOS_DIR: zylosDir,
    PM2_HOME: pm2Home,
    TMPDIR: tmp,
    TMUX_TMPDIR: tmp,
    TZ: 'UTC',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
    FAKE_REPO: REPO,
    FAKE_ARCHIVES: upstream.archives,
    FAKE_CURL_LOG: curlLog,
    FAKE_TAGS: '',
    FAKE_MISSING: '',
  };
  // Read back what the CLI will be given: every place it may write is inside this fresh directory.
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.ok(env[key].startsWith(root + path.sep), `${key} must be inside the test directory: ${env[key]}`);
  }

  const run = (args, { tags = [], missing = [] } = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { ...env, FAKE_TAGS: tags.join(','), FAKE_MISSING: missing.join(',') },
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    assert.equal(result.error, undefined, `zylos ${args.join(' ')} did not finish: ${result.error?.message}`);
    return result;
  };
  const ok = (args, options) => {
    const result = run(args, options);
    assert.equal(result.status, 0, `zylos ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return result;
  };
  const record = () => JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'components.json'), 'utf8'))[NAME];
  const writeRecord = (entry) => {
    const file = path.join(zylosDir, '.zylos', 'components.json');
    const components = JSON.parse(fs.readFileSync(file, 'utf8'));
    components[NAME] = entry;
    fs.writeFileSync(file, `${JSON.stringify(components, null, 2)}\n`);
  };
  const installed = (file) => fs.readFileSync(path.join(zylosDir, '.claude', 'skills', NAME, file), 'utf8');
  const fetched = () => (fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8') : '');
  return { root, zylosDir, run, ok, record, writeRecord, installed, fetched };
}

const githubSource = (ref, refType, commit) => ({ type: 'github-release', repo: REPO, ref, refType, commit });

describe('components.json records where the installed code came from', () => {
  it('a release install and each later upgrade record the tag and commit actually installed', () => {
    const host = makeHost();
    host.ok(['add', `${REPO}@1.0.0`, '--json'], { tags: ['v1.0.0'] });
    const first = host.record();
    assert.equal(first.version, '1.0.0');
    assert.deepEqual(first.source, githubSource('v1.0.0', 'tag', upstream.commits['v1.0.0']));

    host.ok(['upgrade', NAME, '--yes', '--json'], { tags: ['v2.0.0', 'v1.0.0'] });
    const upgraded = host.record();
    assert.equal(upgraded.version, '2.0.0');
    assert.equal(host.installed('payload.txt'), 'payload 2.0.0\n');
    assert.deepEqual(upgraded.source, githubSource('v2.0.0', 'tag', upstream.commits['v2.0.0']));
    assert.equal(upgraded.installedAt, first.installedAt, 'the first install time stays the only record of the first install');

    host.ok(['upgrade', NAME, '--beta', '--yes', '--json'], { tags: ['v2.1.0-beta.1', 'v2.0.0', 'v1.0.0'] });
    assert.deepEqual(host.record().source, githubSource('v2.1.0-beta.1', 'tag', upstream.commits['v2.1.0-beta.1']));
  });

  it('a branch install and a branch upgrade record the branch and the commit it was at', () => {
    const host = makeHost();
    host.ok(['add', REPO, '--branch', 'main', '--json'], { tags: ['v1.0.0'] });
    assert.deepEqual(host.record().source, githubSource('main', 'branch', upstream.commits.main));
    assert.equal(host.record().branch, 'main');

    host.ok(['upgrade', NAME, '--branch', 'feat/x', '--yes', '--json'], { tags: ['v1.0.0'] });
    assert.equal(host.installed('payload.txt'), 'payload 2.0.1\n');
    assert.deepEqual(host.record().source, githubSource('feat/x', 'branch', upstream.commits['feat/x']));
    assert.equal(host.record().branch, 'feat/x', 'the branch field follows the branch now installed');

    // A plain upgrade of a branch install still goes to the latest release, and the record stops naming a branch.
    host.ok(['upgrade', NAME, '--yes', '--json'], { tags: ['v2.3.0', 'v2.0.0', 'v1.0.0'] });
    assert.equal(host.installed('payload.txt'), 'payload 2.3.0\n');
    assert.deepEqual(host.record().source, githubSource('v2.3.0', 'tag', upstream.commits['v2.3.0']));
    assert.equal('branch' in host.record(), false, 'a release install has no branch');
  });

  it('an upgrade whose release archive cannot be downloaded records the main branch it installed instead', () => {
    const host = makeHost();
    host.ok(['add', `${REPO}@1.0.0`, '--json'], { tags: ['v1.0.0'] });

    host.ok(['upgrade', NAME, '--yes', '--json'], { tags: ['v2.0.0', 'v1.0.0'], missing: ['tags/v2.0.0'] });
    assert.match(host.fetched(), /\/archive\/refs\/heads\/main\.tar\.gz/, 'the upgrade fell back to the main branch');
    assert.equal(host.installed('payload.txt'), 'payload 2.2.0\n');
    assert.deepEqual(host.record().source, githubSource('main', 'branch', upstream.commits.main));
    assert.equal(host.record().branch, 'main');
  });

  it('a failed upgrade that rolls back leaves the record of the code still installed', () => {
    const host = makeHost();
    host.ok(['add', `${REPO}@2.0.0`, '--json'], { tags: ['v2.0.0'] });
    const before = host.record();

    const result = host.run(['upgrade', NAME, '--yes', '--json'], { tags: ['v3.0.0', 'v2.0.0'] });
    assert.notEqual(result.status, 0, `the upgrade must fail\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /npm stub refuses/);
    assert.equal(host.installed('payload.txt'), 'payload 2.0.0\n', 'the upgrade was rolled back');
    assert.deepEqual(host.record(), before);
  });

  it('a record written before commits were recorded still upgrades and gains the commit', () => {
    const host = makeHost();
    host.ok(['add', `${REPO}@1.0.0`, '--json'], { tags: ['v1.0.0'] });
    const { source, ...rest } = host.record();
    host.writeRecord({ ...rest, source: { type: 'github-release', repo: REPO, ref: '1.0.0', refType: 'tag' } });

    const check = JSON.parse(host.ok(['upgrade', NAME, '--check', '--json'], { tags: ['v2.0.0', 'v1.0.0'] }).stdout);
    assert.equal(check.current, '1.0.0');
    assert.equal(check.latest, '2.0.0');

    host.ok(['upgrade', NAME, '--yes', '--json'], { tags: ['v2.0.0', 'v1.0.0'] });
    assert.deepEqual(host.record().source, githubSource('v2.0.0', 'tag', upstream.commits['v2.0.0']));
  });

  it('a file delivery records the commit its archive names, and null when the archive names none', () => {
    const delivered = (host, tarball) => {
      fs.writeFileSync(
        path.join(host.zylosDir, '.zylos', 'registry.json'),
        JSON.stringify({ components: { [NAME]: { repo: REPO, type: 'service' } } }),
      );
      const sha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
      host.ok(['add', `${NAME}@2.0.0`, '--file', tarball, '--sha256', sha256, '--json']);
      assert.equal(host.fetched(), '', 'a file delivery downloads nothing');
      return host.record().source;
    };

    const fromGit = makeHost();
    assert.deepEqual(
      delivered(fromGit, path.join(upstream.archives, 'tags', 'v2.0.0.tar.gz')),
      githubSource('v2.0.0', 'tag', upstream.commits['v2.0.0']),
    );

    const fromTar = makeHost();
    const wrapper = path.join(fromTar.root, `zylos-${NAME}`);
    fs.mkdirSync(wrapper);
    fs.writeFileSync(path.join(wrapper, 'SKILL.md'), skillMd('2.0.0'));
    const plain = path.join(fromTar.root, 'plain.tar.gz');
    execFileSync('tar', ['czf', plain, '-C', fromTar.root, path.basename(wrapper)]);
    assert.deepEqual(delivered(fromTar, plain), githubSource('v2.0.0', 'tag', null));
  });
});
