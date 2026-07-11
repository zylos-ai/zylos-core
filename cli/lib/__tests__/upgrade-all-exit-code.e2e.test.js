import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

const CLI = path.join(import.meta.dirname, '..', '..', 'zylos.js');
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-exit-code-e2e-'));
  tmpDirs.push(root);
  const zylosDir = path.join(root, 'zylos-home');
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'components.json'), '{}\n', 'utf8');
  return { root, zylosDir };
}

function writeSkill(dir, { name, version = '1.0.0' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\nversion: ${version}\ndescription: Exit-code contract E2E fixture\n---\n\n# Fixture\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'payload.txt'), `${name} payload\n`, 'utf8');
}

// Remote component registered as github-release; latest tag is served by the
// fake curl below, so `latestTag` controls whether an update is "available".
function installRemoteComponent(zylosDir, { name }) {
  writeSkill(path.join(zylosDir, '.claude', 'skills', name), { name });
  const componentsPath = path.join(zylosDir, '.zylos', 'components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components[name] = {
    version: '1.0.0',
    repo: `example/zylos-${name}`,
    source: {
      type: 'github-release',
      repo: `example/zylos-${name}`,
      ref: '1.0.0',
      refType: 'tag',
    },
  };
  fs.writeFileSync(componentsPath, `${JSON.stringify(components, null, 2)}\n`, 'utf8');
}

// Local-source component: `upgrade --all` check always fails for these
// (local_source_upgrade_unsupported), which is the failure scenario we pin.
function installLocalComponent(root, zylosDir, { name }) {
  const sourceDir = path.join(root, `${name}-source`);
  writeSkill(sourceDir, { name });
  const result = spawnSync(process.execPath, [CLI, 'add', `./${name}-source`, '--json'], {
    cwd: root,
    env: { ...process.env, ZYLOS_DIR: zylosDir },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, `add failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function installFakeCurl(root, { latestTag }) {
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, 'curl'),
    `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '[{"name":"${latestTag}"}]'\n`,
    { mode: 0o755 }
  );
  return fakeBin;
}

function runCheckAll(root, zylosDir, { json }) {
  const fakeBin = path.join(root, 'bin');
  const args = ['upgrade', '--all', '--check'];
  if (json) args.push('--json');
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: {
      ...process.env,
      ZYLOS_DIR: zylosDir,
      PATH: fs.existsSync(fakeBin) ? `${fakeBin}${path.delimiter}${process.env.PATH}` : process.env.PATH,
      GITHUB_TOKEN: 'test-token',
      GH_TOKEN: '',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
}

describe('upgrade --all exit-code contract (#706): JSON and non-JSON agree', () => {
  it('all checks pass → exit 0 in both modes', () => {
    const { root, zylosDir } = makeFixture();
    installRemoteComponent(zylosDir, { name: 'exit-code-pass-e2e' });
    installFakeCurl(root, { latestTag: 'v1.0.0' }); // no update available

    const json = runCheckAll(root, zylosDir, { json: true });
    assert.equal(json.status, 0, json.stderr);
    const output = JSON.parse(json.stdout);
    assert.equal(output.success, true);
    assert.equal(output.failed, 0);

    const plain = runCheckAll(root, zylosDir, { json: false });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /All components are up to date/);
  });

  it('partial failure (one check fails, one update available) → exit 1 in both modes', () => {
    const { root, zylosDir } = makeFixture();
    installLocalComponent(root, zylosDir, { name: 'exit-code-local-e2e' });
    installRemoteComponent(zylosDir, { name: 'exit-code-remote-e2e' });
    installFakeCurl(root, { latestTag: 'v2.0.0' }); // update available for the remote one

    const json = runCheckAll(root, zylosDir, { json: true });
    assert.equal(json.status, 1, json.stderr);
    const output = JSON.parse(json.stdout);
    assert.equal(output.success, false);
    assert.equal(output.failed, 1);
    assert.equal(output.updatable, 1);
    assert.equal(output.error, 'component_checks_failed');

    const plain = runCheckAll(root, zylosDir, { json: false });
    assert.equal(plain.status, 1, plain.stderr);
    assert.match(plain.stdout, /1.*component\(s\) have updates available/);
  });

  it('all checks fail → exit 1 in both modes', () => {
    const { root, zylosDir } = makeFixture();
    installLocalComponent(root, zylosDir, { name: 'exit-code-all-fail-e2e' });

    const json = runCheckAll(root, zylosDir, { json: true });
    assert.equal(json.status, 1, json.stderr);
    const output = JSON.parse(json.stdout);
    assert.equal(output.success, false);
    assert.equal(output.failed, 1);
    assert.equal(output.error, 'component_checks_failed');

    const plain = runCheckAll(root, zylosDir, { json: false });
    assert.equal(plain.status, 1, plain.stderr);
    assert.match(plain.stdout, /No remotely updatable components found/);
  });
});
