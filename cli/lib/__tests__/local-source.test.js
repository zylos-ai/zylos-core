import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { acquireSource, inspectLocalSource, registerSourceResolver } from '../download.js';
import { resolveTarget } from '../components.js';

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
