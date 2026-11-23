import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { inspectLocalSource } from '../download.js';
import { isLocalPathSpecifier } from '../components.js';

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

});
