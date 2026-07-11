import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { acquireSource, inspectLocalSource, registerSourceResolver } from '../download.js';
import { isLocalPathSpecifier, resolveTarget } from '../components.js';

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-local-source-test-'));
  tmpDirs.push(dir);
  return dir;
}

function writeSkill(dir, frontmatter) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# Fixture\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'payload.txt'), 'fixture payload\n', 'utf8');
}

function writePackage(dir, version) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }), 'utf8');
}

describe('local component source resolution', () => {
  it('reads name and version from SKILL.md for a local directory', async () => {
    const root = makeTmpDir();
    const sourceDir = path.join(root, 'source-dir');
    writeSkill(sourceDir, 'name: directory-fixture\nversion: 1.2.3');

    const inspected = inspectLocalSource(sourceDir);
    const resolved = await resolveTarget(sourceDir);

    assert.deepEqual(inspected, {
      name: 'directory-fixture',
      version: '1.2.3',
      source: { type: 'local-dir', path: sourceDir },
    });
    assert.equal(resolved.name, 'directory-fixture');
    assert.equal(resolved.version, '1.2.3');
    assert.equal(resolved.source.type, 'local-dir');
  });

  it('reads VERSION from a wrapped local tarball and acquires its contents', () => {
    const root = makeTmpDir();
    const wrapper = path.join(root, 'wrapped-component');
    const tarball = path.join(root, 'fixture.tar.gz');
    const dest = path.join(root, 'dest');
    writeSkill(wrapper, 'name: tarball-fixture');
    fs.writeFileSync(path.join(wrapper, 'VERSION'), '2.4.6\n', 'utf8');
    execFileSync('tar', ['czf', tarball, '-C', root, path.basename(wrapper)]);

    const inspected = inspectLocalSource(tarball);
    const acquired = acquireSource(inspected.source, dest);

    assert.equal(inspected.name, 'tarball-fixture');
    assert.equal(inspected.version, '2.4.6');
    assert.equal(inspected.source.type, 'local-tarball');
    assert.equal(acquired.success, true);
    assert.equal(fs.readFileSync(path.join(dest, 'payload.txt'), 'utf8'), 'fixture payload\n');
    assert.equal(fs.existsSync(path.join(dest, path.basename(wrapper))), false);
  });

  it('recognizes only explicit local path forms without cwd-based bare-name collisions', () => {
    for (const value of ['./telegram', '../telegram', '/tmp/telegram', '~/telegram', 'build.tgz', 'build.tar.gz']) {
      assert.equal(isLocalPathSpecifier(value), true, value);
    }
    for (const value of [
      'telegram',
      'lark',
      'example/zylos-demo',
      'https://github.com/example/zylos-demo/archive/refs/tags/v1.0.0.tar.gz',
    ]) {
      assert.equal(isLocalPathSpecifier(value), false, value);
    }
  });

  it('keeps an unknown local version null', async () => {
    const root = makeTmpDir();
    const sourceDir = path.join(root, 'source-dir');
    writeSkill(sourceDir, 'name: unknown-version-fixture');

    const inspected = inspectLocalSource(sourceDir);
    const resolved = await resolveTarget(sourceDir);

    assert.equal(inspected.version, null);
    assert.equal(resolved.version, null);
  });

  it('reads a package-only version from a local directory', () => {
    const root = makeTmpDir();
    const sourceDir = path.join(root, 'source-dir');
    writeSkill(sourceDir, 'name: package-directory-fixture');
    writePackage(sourceDir, '6.7.8');

    assert.equal(inspectLocalSource(sourceDir).version, '6.7.8');
  });

  it('reads a package-only version from a wrapped local tarball', () => {
    const root = makeTmpDir();
    const wrapper = path.join(root, 'wrapped-component');
    const tarball = path.join(root, 'fixture.tar.gz');
    writeSkill(wrapper, 'name: package-tarball-fixture');
    writePackage(wrapper, '7.8.9');
    execFileSync('tar', ['czf', tarball, '-C', root, path.basename(wrapper)]);

    assert.equal(inspectLocalSource(tarball).version, '7.8.9');
  });

  it('rejects local tarballs containing symbolic links before extraction', () => {
    const root = makeTmpDir();
    const wrapper = path.join(root, 'wrapped-component');
    const tarball = path.join(root, 'fixture.tar.gz');
    writeSkill(wrapper, 'name: malicious-tarball-fixture\nversion: 1.0.0');
    fs.symlinkSync('../../outside', path.join(wrapper, 'escape'));
    execFileSync('tar', ['czf', tarball, '-C', root, path.basename(wrapper)]);

    assert.throws(
      () => inspectLocalSource(tarball),
      /symbolic or hard link; links are not allowed/
    );
  });

  it('rejects local tarballs containing hard links before extraction', () => {
    const root = makeTmpDir();
    const wrapper = path.join(root, 'wrapped-component');
    const tarball = path.join(root, 'fixture.tar.gz');
    writeSkill(wrapper, 'name: malicious-hardlink-fixture\nversion: 1.0.0');
    fs.linkSync(path.join(wrapper, 'payload.txt'), path.join(wrapper, 'payload-hardlink.txt'));
    execFileSync('tar', ['czf', tarball, '-C', root, path.basename(wrapper)]);

    assert.throws(
      () => inspectLocalSource(tarball),
      /symbolic or hard link; links are not allowed/
    );
  });

  it('rejects missing paths and invalid local component names', async () => {
    const root = makeTmpDir();
    const missing = await resolveTarget(path.join(root, 'missing'));
    assert.match(missing.resolutionError, /Local source not found/);

    const invalidDir = path.join(root, 'invalid');
    writeSkill(invalidDir, 'name: invalid/name');
    const invalid = await resolveTarget(invalidDir);
    assert.match(invalid.resolutionError, /Invalid local component name/);
  });

  it('excludes generated and private runtime directories when copying a local source', () => {
    const root = makeTmpDir();
    const sourceDir = path.join(root, 'source-dir');
    const dest = path.join(root, 'dest');
    writeSkill(sourceDir, 'name: copy-filter-fixture\nversion: 1.0.0');
    for (const excluded of ['node_modules', '.zylos', '.backup', '.git']) {
      fs.mkdirSync(path.join(sourceDir, excluded), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, excluded, 'private.txt'), 'do not copy', 'utf8');
    }

    const result = acquireSource(inspectLocalSource(sourceDir).source, dest);

    assert.equal(result.success, true);
    for (const excluded of ['node_modules', '.zylos', '.backup', '.git']) {
      assert.equal(fs.existsSync(path.join(dest, excluded)), false, excluded);
    }
  });

  it('keeps an absent org/repo target on the GitHub path', async () => {
    const resolved = await resolveTarget('example/zylos-demo@9.8.7');

    assert.equal(resolved.name, 'demo');
    assert.equal(resolved.repo, 'example/zylos-demo');
    assert.deepEqual(resolved.source, {
      type: 'github-release',
      repo: 'example/zylos-demo',
      ref: '9.8.7',
      refType: 'tag',
    });
  });

  it('allows future acquire resolvers to be registered without changing add', () => {
    const root = makeTmpDir();
    const dest = path.join(root, 'dest');
    registerSourceResolver('test-resolver', {
      acquire(source, targetDir) {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'value'), source.value, 'utf8');
        return { success: true, extractedDir: targetDir };
      },
    });

    const result = acquireSource({ type: 'test-resolver', value: 'extension seam' }, dest);

    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(dest, 'value'), 'utf8'), 'extension seam');
  });
});
