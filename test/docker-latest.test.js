import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { isLatestStableTag } from '../scripts/docker-latest.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

describe('latest stable version selection', () => {
  test.each([
    ['stable patch', 'v0.9.4', ['v0.9.3', 'v0.9.4'], true],
    ['beta', 'v1.0.0-beta.1', ['v0.9.4', 'v1.0.0-beta.1'], false],
    ['release candidate', 'v1.0.0-rc.2', ['v1.0.0-rc.2'], false],
    ['older release line', 'v0.9.5', ['v0.9.5', 'v1.0.0'], false],
    ['next stable patch', 'v1.0.1', ['v1.0.0', 'v1.0.1', 'v2.0.0-beta.1'], true],
    ['unrelated tags', 'v0.9.4', ['issue-520-assets', 'v0.9.4', 'v99.0', '1.0.0'], true],
    ['numeric minor order', 'v1.9.9', ['v1.10.0', 'v1.9.9'], false],
    ['numeric patch order', 'v1.0.10', ['v1.0.9', 'v1.0.10'], true],
    ['large numeric components', 'v9007199254740992.0.0', ['v9007199254740992.0.0', 'v9007199254740993.0.0'], false],
    ['build metadata tie', 'v1.0.0+linux.01', ['v1.0.0+linux.01', 'v1.0.0+other', 'v1.0.0'], true],
    ['higher stable with metadata', 'v1.0.0', ['v1.0.0', 'v1.0.1+build'], false],
    ['empty list', 'v1.0.0', [], false],
    ['current tag absent', 'v1.0.0', ['v0.9.4'], false],
    ...['1.0.0', 'v1.0', 'v01.0.0', 'v1.0.0-beta.01', 'v1.0.0+', 'v1.0.0\n'].map(tag =>
      ['invalid current ' + JSON.stringify(tag), tag, [tag], false]),
  ])('%s', (_name, current, tags, expected) => {
    expect(isLatestStableTag(current, tags)).toBe(expected);
  });
});

// Covers the real CLI/git/output boundary. Run when the script or workflow wiring
// changes; skip for documentation-only edits. Every case uses fake git, no network,
// private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/cwd and no inherited credentials/config.
// tmux and databases are not exercised. afterEach removes only this case's fixture.
describe('git tag output integration', () => {
  test.each([
    ['highest stable', 'refs/tags/v0.9.4', 'v0.9.3\nv0.9.4\nissue-520-assets\n', 0, true],
    ['prerelease', 'refs/tags/v1.0.0-beta.1', 'v1.0.0-beta.1\n', 0, false],
    ['older stable', 'refs/tags/v0.9.5', 'v1.0.0\nv0.9.5\n', 0, false],
    ['next stable', 'refs/tags/v1.0.1', 'v1.0.0\r\nv1.0.1\r\n', 0, true],
    ['empty tags', 'refs/tags/v1.0.0', '', 0, false],
    ['unavailable tags', 'refs/tags/v1.0.0', '', 1, false],
    ['missing current', 'refs/tags/v1.0.0', 'v0.9.4\n', 0, false],
    ['branch ref', 'refs/heads/main', 'v1.0.0\n', 0, false],
  ])('%s', (_name, ref, tags, gitExit, expected) => {
    const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dlt-')));
    fixtures.push(fixture);
    const dirs = Object.fromEntries(['home', 'zylos', 'pm2', 'tmp', 'bin', 'cwd'].map(name => {
      const dir = path.join(fixture, name);
      fs.mkdirSync(dir);
      return [name, fs.realpathSync(dir)];
    }));
    const output = path.join(fixture, 'output');
    const calls = path.join(fixture, 'calls');
    fs.writeFileSync(path.join(dirs.bin, 'git'), `#!${process.execPath}
import('node:fs').then(fs => {
  fs.appendFileSync(process.env.GIT_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
  process.stdout.write(process.env.TAG_LIST);
  process.exitCode = Number(process.env.GIT_EXIT);
});
`, { mode: 0o700 });
    const env = {
      HOME: dirs.home, ZYLOS_DIR: dirs.zylos, PM2_HOME: dirs.pm2, TMPDIR: dirs.tmp,
      PATH: dirs.bin, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'),
      GITHUB_REF: ref, GITHUB_OUTPUT: output, TAG_LIST: tags, GIT_EXIT: String(gitExit), GIT_CALLS: calls,
    };
    // Read back actual isolation targets before spawning, failing closed on drift.
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'PATH']) {
      expect(fs.realpathSync(env[key]).startsWith(fixture + path.sep)).toBe(true);
    }
    expect(fs.realpathSync(dirs.cwd).startsWith(fixture + path.sep)).toBe(true);
    expect(Object.keys(env).sort()).toEqual([
      'GITHUB_OUTPUT', 'GITHUB_REF', 'GIT_CALLS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
      'GIT_EXIT', 'HOME', 'PATH', 'PM2_HOME', 'TAG_LIST', 'TMPDIR', 'ZYLOS_DIR',
    ].sort());
    console.info('isolated docker tag subprocess', JSON.stringify({ cwd: dirs.cwd, ...env, TAG_LIST: undefined }));
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/docker-latest.js')], {
      cwd: dirs.cwd, env, encoding: 'utf8', timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(output, 'utf8')).toBe(`latest=${expected}\n`);
    if (ref.startsWith('refs/tags/')) {
      expect(fs.readFileSync(calls, 'utf8')).toBe(JSON.stringify([
        'for-each-ref', '--format=%(refname:strip=2)', 'refs/tags',
      ]) + '\n');
    } else {
      expect(fs.existsSync(calls)).toBe(false);
    }
  });
});

test('workflow fetches all tags and gates the sole latest rule on script output', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/docker-publish.yml'), 'utf8'));
  const steps = workflow.jobs['build-and-push'].steps;
  expect(steps.find(step => step.uses === 'actions/checkout@v4').with['fetch-depth']).toBe(0);
  const stable = steps.find(step => step.id === 'stable');
  expect(stable.if).toBe("startsWith(github.ref, 'refs/tags/')");
  expect(stable.run).toBe('node scripts/docker-latest.js');
  const metadata = steps.find(step => step.uses === 'docker/metadata-action@v5');
  expect(steps.indexOf(stable)).toBeLessThan(steps.indexOf(metadata));
  expect(metadata.with.flavor).toBe('latest=false');
  expect(metadata.with.tags.split('\n').filter(line => line && !line.trimStart().startsWith('#'))).toEqual([
    'type=semver,pattern={{version}}',
    'type=semver,pattern={{major}}.{{minor}}',
    "type=raw,value=latest,enable=${{ steps.stable.outputs.latest == 'true' }}",
    'type=raw,value=main,enable={{is_default_branch}}',
  ]);
});
