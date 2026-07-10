import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

const CLI = path.join(import.meta.dirname, '..', '..', 'zylos.js');
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-local-add-e2e-'));
  tmpDirs.push(root);
  const zylosDir = path.join(root, 'zylos-home');
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'components.json'), '{}\n', 'utf8');
  return { root, zylosDir };
}

function writeSkill(dir, { name, version = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const versionLine = version ? `\nversion: ${version}` : '';
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}${versionLine}\ndescription: Local source E2E fixture\n---\n\n# Fixture\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'payload.txt'), `${name} payload\n`, 'utf8');
}

function runAdd({ cwd, zylosDir, target, env = {} }) {
  const result = spawnSync(process.execPath, [CLI, 'add', target, '--json'], {
    cwd,
    env: { ...process.env, ZYLOS_DIR: zylosDir, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, `add failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function runCli({ cwd, zylosDir, args, env = {} }) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ZYLOS_DIR: zylosDir, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function readInstalled(zylosDir, name) {
  const components = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'components.json'), 'utf8'));
  const skillDir = path.join(zylosDir, '.claude', 'skills', name);
  return { components, skillDir };
}

describe('zylos add local source E2E', () => {
  it('installs an explicit relative directory through the complete add pipeline', () => {
    const { root, zylosDir } = makeFixture();
    const sourceName = 'relative-component';
    writeSkill(path.join(root, sourceName), { name: 'local-directory-e2e', version: '3.1.4' });

    const output = runAdd({ cwd: root, zylosDir, target: `./${sourceName}` });
    const { components, skillDir } = readInstalled(zylosDir, 'local-directory-e2e');

    assert.equal(output.success, true);
    assert.equal(output.component, 'local-directory-e2e');
    assert.equal(output.version, '3.1.4');
    assert.equal(components['local-directory-e2e'].version, '3.1.4');
    assert.equal(components['local-directory-e2e'].source.type, 'local-dir');
    assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'local-directory-e2e payload\n');
    assert.equal(fs.existsSync(path.join(skillDir, '.zylos', 'manifest.json')), true);
  });

  it('uses an absolute local path in --check confirmation output', () => {
    const { root, zylosDir } = makeFixture();
    const sourceName = 'relative-component';
    const sourceDir = path.join(root, sourceName);
    writeSkill(sourceDir, { name: 'local-check-e2e', version: '4.5.6' });

    const result = runCli({ cwd: root, zylosDir, args: ['add', `./${sourceName}`, '--check', '--json'] });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const canonicalSourceDir = fs.realpathSync(sourceDir);
    assert.equal(output.source.path, canonicalSourceDir);
    assert.match(output.reply, new RegExp(canonicalSourceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('does not let a cwd directory hijack a bare component name', () => {
    const { root, zylosDir } = makeFixture();
    writeSkill(path.join(root, 'not-in-registry'), { name: 'hijacked-local', version: '1.0.0' });

    const result = runCli({ cwd: root, zylosDir, args: ['add', 'not-in-registry', '--json'] });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error, 'not_found');
    assert.equal(fs.existsSync(path.join(zylosDir, '.claude', 'skills', 'hijacked-local')), false);
  });

  it('installs a local tarball and records its VERSION metadata', () => {
    const { root, zylosDir } = makeFixture();
    const wrapper = path.join(root, 'tar-wrapper');
    const tarball = path.join(root, 'component.tar.gz');
    writeSkill(wrapper, { name: 'local-tarball-e2e' });
    fs.writeFileSync(path.join(wrapper, 'VERSION'), '5.6.7\n', 'utf8');
    execFileSync('tar', ['czf', tarball, '-C', root, path.basename(wrapper)]);

    const output = runAdd({ cwd: root, zylosDir, target: './component.tar.gz' });
    const { components, skillDir } = readInstalled(zylosDir, 'local-tarball-e2e');

    assert.equal(output.success, true);
    assert.equal(output.component, 'local-tarball-e2e');
    assert.equal(output.version, '5.6.7');
    assert.equal(components['local-tarball-e2e'].version, '5.6.7');
    assert.equal(components['local-tarball-e2e'].source.type, 'local-tarball');
    assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'local-tarball-e2e payload\n');
    assert.equal(fs.existsSync(path.join(skillDir, '.zylos', 'manifest.json')), true);
  });

  it('keeps the GitHub release acquisition path working', () => {
    const { root, zylosDir } = makeFixture();
    const wrapper = path.join(root, 'github-wrapper');
    const tarball = path.join(root, 'github-release.tar.gz');
    const fakeBin = path.join(root, 'bin');
    const fakeCurl = path.join(fakeBin, 'curl');
    const fakeCurlModule = path.join(fakeBin, 'curl.mjs');
    writeSkill(wrapper, { name: 'github-fixture', version: '9.9.9' });
    execFileSync('tar', ['czf', tarball, '-C', root, path.basename(wrapper)]);
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(fakeCurlModule, `
import fs from 'node:fs';
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
const url = args.at(-1) || '';
if (outputIndex !== -1 && url.includes('/archive/refs/tags/')) {
  fs.copyFileSync(process.env.FAKE_GITHUB_TARBALL, args[outputIndex + 1]);
  process.exit(0);
}
process.exit(22);
`, 'utf8');
    fs.writeFileSync(fakeCurl, `#!/bin/sh
exec "${process.execPath}" "$(dirname "$0")/curl.mjs" "$@"
`, { mode: 0o755 });

    const output = runAdd({
      cwd: root,
      zylosDir,
      target: 'example/zylos-github-fixture@1.0.0',
      env: {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        FAKE_GITHUB_TARBALL: tarball,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
      },
    });
    const { components, skillDir } = readInstalled(zylosDir, 'github-fixture');

    assert.equal(output.success, true);
    assert.equal(output.version, '1.0.0');
    assert.equal(components['github-fixture'].repo, 'example/zylos-github-fixture');
    assert.deepEqual(components['github-fixture'].source, {
      type: 'github-release',
      repo: 'example/zylos-github-fixture',
      ref: '1.0.0',
      refType: 'tag',
    });
    assert.equal(fs.readFileSync(path.join(skillDir, 'payload.txt'), 'utf8'), 'github-fixture payload\n');
  });

  it('rejects upgrade checks for locally installed components with reinstall guidance', () => {
    const { root, zylosDir } = makeFixture();
    const sourceDir = path.join(root, 'local-upgrade-source');
    writeSkill(sourceDir, { name: 'local-upgrade-e2e', version: '1.0.0' });
    runAdd({ cwd: root, zylosDir, target: './local-upgrade-source' });

    const result = runCli({
      cwd: root,
      zylosDir,
      args: ['upgrade', 'local-upgrade-e2e', '--check', '--json'],
    });

    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error, 'local_source_upgrade_unsupported');
    assert.equal(output.source.path, fs.realpathSync(sourceDir));
    assert.match(output.message, /Reinstall it from/);

    const branchResult = runCli({
      cwd: root,
      zylosDir,
      args: ['upgrade', 'local-upgrade-e2e', '--check', '--branch', 'main', '--json'],
    });
    assert.equal(branchResult.status, 1);
    assert.equal(JSON.parse(branchResult.stdout).error, 'local_source_upgrade_unsupported');
  });

  it('reports and skips locally installed components during upgrade --all', () => {
    const { root, zylosDir } = makeFixture();
    const sourceDir = path.join(root, 'local-upgrade-all-source');
    writeSkill(sourceDir, { name: 'local-upgrade-all-e2e', version: '1.0.0' });
    runAdd({ cwd: root, zylosDir, target: './local-upgrade-all-source' });

    fs.writeFileSync(
      path.join(sourceDir, 'payload.txt'),
      'changed source must not overwrite the installed component\n',
      'utf8'
    );
    const result = runCli({
      cwd: root,
      zylosDir,
      args: ['upgrade', '--all', '--yes', '--json'],
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.updatable, 0);
    assert.equal(output.components.length, 1);
    assert.equal(output.components[0].component, 'local-upgrade-all-e2e');
    assert.equal(output.components[0].error, 'local_source_upgrade_unsupported');
    assert.equal(
      fs.readFileSync(
        path.join(zylosDir, '.claude', 'skills', 'local-upgrade-all-e2e', 'payload.txt'),
        'utf8'
      ),
      'local-upgrade-all-e2e payload\n'
    );
  });
});
