import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

const CLI = path.join(import.meta.dirname, '..', '..', 'zylos.js');
const COMPONENT = 'file-e2e';
const REPO = 'example/zylos-file-e2e';
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-file-delivery-e2e-'));
  tmpDirs.push(root);
  const zylosDir = path.join(root, 'zylos-home');
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'components.json'), '{}\n', 'utf8');
  // Offline registry override: maps the fixture name to its official repo
  fs.writeFileSync(
    path.join(zylosDir, '.zylos', 'registry.json'),
    JSON.stringify({ components: { [COMPONENT]: { repo: REPO, type: 'service' } } }),
    'utf8'
  );
  return { root, zylosDir };
}

function makeTarball(root, { name = COMPONENT, version = '1.0.0' } = {}) {
  const wrapper = path.join(root, `zylos-${name}`);
  fs.mkdirSync(wrapper, { recursive: true });
  const versionLine = version ? `\nversion: ${version}` : '';
  fs.writeFileSync(
    path.join(wrapper, 'SKILL.md'),
    `---\nname: ${name}${versionLine}\ndescription: Official file delivery E2E fixture\n---\n\n# Fixture\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(wrapper, 'payload.txt'), `${name} payload\n`, 'utf8');
  const tarball = path.join(root, `zylos-${name}-${version || 'unversioned'}.tar.gz`);
  execFileSync('tar', ['czf', tarball, '-C', root, path.basename(wrapper)]);
  fs.rmSync(wrapper, { recursive: true, force: true });
  return tarball;
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * A curl that always fails: any network attempt during a --file install
 * breaks the test, proving the flow is fully offline.
 */
function poisonNetwork(root) {
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'curl'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  return {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  };
}

function runCli({ cwd, zylosDir, args, env = {} }) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ZYLOS_DIR: zylosDir, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function readComponents(zylosDir) {
  return JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'components.json'), 'utf8'));
}

function assertNoResidue(zylosDir) {
  assert.deepEqual(readComponents(zylosDir), {});
  assert.equal(fs.existsSync(path.join(zylosDir, '.claude', 'skills', COMPONENT)), false);
}

describe('zylos add --file official delivery E2E', () => {
  it('installs an official component from a verified tarball with zero network', () => {
    const { root, zylosDir } = makeFixture();
    const tarball = makeTarball(root);
    const env = poisonNetwork(root);

    const result = runCli({
      cwd: root, zylosDir, env,
      args: ['add', `${COMPONENT}@1.0.0`, '--file', tarball, '--sha256', sha256(tarball), '--json'],
    });

    assert.equal(result.status, 0, `add failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, true);
    assert.equal(output.component, COMPONENT);
    assert.equal(output.version, '1.0.0');

    const entry = readComponents(zylosDir)[COMPONENT];
    assert.equal(entry.version, '1.0.0');
    assert.equal(entry.repo, REPO);
    assert.equal(entry.isThirdParty, false);
    assert.deepEqual(entry.source, {
      type: 'github-release',
      repo: REPO,
      ref: '1.0.0',
      refType: 'tag',
    });
    assert.equal(entry.deliveredVia.type, 'file');
    assert.equal(entry.deliveredVia.path, tarball);
    assert.equal(entry.deliveredVia.sha256, sha256(tarball));
    assert.equal(entry.deliveredVia.verified, true);

    const skillDir = path.join(zylosDir, '.claude', 'skills', COMPONENT);
    assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), `${COMPONENT} payload\n`);
    assert.equal(fs.existsSync(path.join(skillDir, '.zylos', 'manifest.json')), true);
  });

  it('fails closed with no residue when the target version mismatches the archive', () => {
    const { root, zylosDir } = makeFixture();
    const tarball = makeTarball(root, { version: '1.0.0' });

    const result = runCli({
      cwd: root, zylosDir, env: poisonNetwork(root),
      args: ['add', `${COMPONENT}@2.0.0`, '--file', tarball, '--sha256', sha256(tarball), '--json'],
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, false);
    assert.match(output.message, /Version mismatch/);
    assertNoResidue(zylosDir);
  });

  it('fails closed before unpacking when the sha256 does not match', () => {
    const { root, zylosDir } = makeFixture();
    const tarball = makeTarball(root);

    const result = runCli({
      cwd: root, zylosDir, env: poisonNetwork(root),
      args: ['add', `${COMPONENT}@1.0.0`, '--file', tarball, '--sha256', 'a'.repeat(64), '--json'],
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error, 'checksum_mismatch');
    assertNoResidue(zylosDir);
  });

  it('leaves the installed component on the normal upgrade path', () => {
    const { root, zylosDir } = makeFixture();
    const tarball = makeTarball(root);

    const install = runCli({
      cwd: root, zylosDir, env: poisonNetwork(root),
      args: ['add', COMPONENT, '--file', tarball, '--sha256', sha256(tarball), '--json'],
    });
    assert.equal(install.status, 0, install.stdout);

    // Fake GitHub tag listing: the official repo has a newer release
    const fakeBin = path.join(root, 'upgrade-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, 'curl'),
      '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'[{"name":"v2.0.0"}]\'\n',
      { mode: 0o755 }
    );

    const result = runCli({
      cwd: root, zylosDir,
      args: ['upgrade', COMPONENT, '--check', '--json'],
      env: {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        GITHUB_TOKEN: 'test-token',
        GH_TOKEN: '',
      },
    });

    assert.equal(result.status, 0, result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, true);
    assert.notEqual(output.error, 'local_source_upgrade_unsupported');
    assert.equal(output.hasUpdate, true);
    assert.equal(output.current, '1.0.0');
    assert.equal(output.latest, '2.0.0');
    assert.equal(output.repo, REPO);
  });

  it('records an unverified install with --trust-file and warns in list output', () => {
    const { root, zylosDir } = makeFixture();
    const tarball = makeTarball(root);

    const result = runCli({
      cwd: root, zylosDir, env: poisonNetwork(root),
      args: ['add', COMPONENT, '--file', tarball, '--trust-file', '--json'],
    });

    assert.equal(result.status, 0, result.stdout);
    const entry = readComponents(zylosDir)[COMPONENT];
    assert.equal(entry.deliveredVia.verified, false);
    assert.equal(entry.deliveredVia.sha256, null);

    const list = runCli({ cwd: root, zylosDir, args: ['list'] });
    assert.equal(list.status, 0);
    assert.match(list.stdout, /checksum NOT verified/);
  });

  it('rejects --file without --sha256 or --trust-file', () => {
    const { root, zylosDir } = makeFixture();
    const tarball = makeTarball(root);

    const result = runCli({
      cwd: root, zylosDir, env: poisonNetwork(root),
      args: ['add', COMPONENT, '--file', tarball, '--json'],
    });

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error, 'checksum_required');
    assertNoResidue(zylosDir);
  });

  it('rejects --file combined with --branch', () => {
    const { root, zylosDir } = makeFixture();
    const tarball = makeTarball(root);

    const result = runCli({
      cwd: root, zylosDir, env: poisonNetwork(root),
      args: ['add', COMPONENT, '--file', tarball, '--trust-file', '--branch', 'main', '--json'],
    });

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error, 'conflict');
    assertNoResidue(zylosDir);
  });

  it('rejects a component name missing from the offline registry', () => {
    const { root, zylosDir } = makeFixture();
    const tarball = makeTarball(root, { name: 'unknown-component' });

    const result = runCli({
      cwd: root, zylosDir, env: poisonNetwork(root),
      args: ['add', 'unknown-component', '--file', tarball, '--sha256', sha256(tarball), '--json'],
    });

    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).message, /not in the offline registry/);
    assertNoResidue(zylosDir);
  });

  it('shows offline component info with verification status in --check mode', () => {
    const { root, zylosDir } = makeFixture();
    const tarball = makeTarball(root);

    const result = runCli({
      cwd: root, zylosDir, env: poisonNetwork(root),
      args: ['add', `${COMPONENT}@1.0.0`, '--file', tarball, '--sha256', sha256(tarball), '--check', '--json'],
    });

    assert.equal(result.status, 0, result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, true);
    assert.equal(output.version, '1.0.0');
    assert.deepEqual(output.source, {
      type: 'github-release',
      repo: REPO,
      ref: '1.0.0',
      refType: 'tag',
    });
    assert.equal(output.deliveredVia.verified, true);
    assert.match(output.reply, /sha256 verified/);
    assertNoResidue(zylosDir);
  });
});
