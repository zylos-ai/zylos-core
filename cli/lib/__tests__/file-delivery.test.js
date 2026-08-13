import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

// Sandbox ZYLOS_DIR before importing so the offline registry lookup reads a
// hermetic ~/.zylos/registry.json instead of the developer's real one.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-file-delivery-test-'));
process.env.ZYLOS_DIR = sandbox;
fs.mkdirSync(path.join(sandbox, '.zylos'), { recursive: true });
fs.writeFileSync(
  path.join(sandbox, '.zylos', 'registry.json'),
  JSON.stringify({
    components: {
      'file-fixture': { repo: 'zylos-ai/zylos-file-fixture', type: 'service' },
    },
  }),
  'utf8'
);

const { resolveTarget } = await import('../components.js');
const { sha256File, isValidSha256Hex } = await import('../checksum.js');

const tmpDirs = [sandbox];

after(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-file-delivery-tmp-'));
  tmpDirs.push(dir);
  return dir;
}

function makeTarball({ name = 'file-fixture', version = null, skillName = name } = {}) {
  const root = makeTmpDir();
  const wrapper = path.join(root, `zylos-${name}`);
  fs.mkdirSync(wrapper, { recursive: true });
  const versionLine = version ? `\nversion: ${version}` : '';
  fs.writeFileSync(
    path.join(wrapper, 'SKILL.md'),
    `---\nname: ${skillName}${versionLine}\ndescription: File delivery fixture\n---\n\n# Fixture\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(wrapper, 'payload.txt'), 'file delivery payload\n', 'utf8');
  const tarball = path.join(root, `zylos-${name}.tar.gz`);
  execFileSync('tar', ['czf', tarball, '-C', root, path.basename(wrapper)]);
  return tarball;
}

describe('checksum utilities', () => {
  it('computes the sha256 digest of a file', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'payload.txt');
    fs.writeFileSync(file, 'hello\n', 'utf8');
    assert.equal(
      sha256File(file),
      '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03'
    );
  });

  it('validates sha256 hex digests strictly', () => {
    assert.equal(isValidSha256Hex('a'.repeat(64)), true);
    assert.equal(isValidSha256Hex('A0'.repeat(32)), true);
    assert.equal(isValidSha256Hex('a'.repeat(63)), false);
    assert.equal(isValidSha256Hex('a'.repeat(65)), false);
    assert.equal(isValidSha256Hex('g'.repeat(64)), false);
    assert.equal(isValidSha256Hex(null), false);
    assert.equal(isValidSha256Hex(42), false);
  });
});

describe('resolveTarget with --file (official file delivery)', () => {
  it('resolves a registry name against a tarball with split identity and acquisition', async () => {
    const tarball = makeTarball({ version: '1.2.3' });
    const resolved = await resolveTarget('file-fixture', { file: tarball });

    assert.equal(resolved.resolutionError, undefined);
    assert.equal(resolved.name, 'file-fixture');
    assert.equal(resolved.repo, 'zylos-ai/zylos-file-fixture');
    assert.equal(resolved.version, '1.2.3');
    assert.equal(resolved.isThirdParty, false);
    assert.deepEqual(resolved.source, {
      type: 'github-release',
      repo: 'zylos-ai/zylos-file-fixture',
      ref: '1.2.3',
      refType: 'tag',
    });
    assert.deepEqual(resolved.acquisition, {
      type: 'local-tarball',
      path: path.resolve(tarball),
    });
  });

  it('accepts a matching explicit version and normalizes a leading v', async () => {
    const tarball = makeTarball({ version: '1.2.3' });
    const resolved = await resolveTarget('file-fixture@v1.2.3', { file: tarball });

    assert.equal(resolved.resolutionError, undefined);
    assert.equal(resolved.version, '1.2.3');
    assert.equal(resolved.source.ref, '1.2.3');
  });

  it('uses the explicit version when the archive has no version metadata', async () => {
    const tarball = makeTarball({ version: null });
    const resolved = await resolveTarget('file-fixture@2.0.0', { file: tarball });

    assert.equal(resolved.resolutionError, undefined);
    assert.equal(resolved.version, '2.0.0');
    assert.deepEqual(resolved.source, {
      type: 'github-release',
      repo: 'zylos-ai/zylos-file-fixture',
      ref: '2.0.0',
      refType: 'tag',
    });
  });

  it('fails closed when the name is not in the offline registry', async () => {
    const tarball = makeTarball({ skillName: 'not-registered' });
    const resolved = await resolveTarget('not-registered', { file: tarball });

    assert.match(resolved.resolutionError, /not in the offline registry/);
    assert.equal(resolved.source, null);
  });

  it('fails closed when the explicit version conflicts with archive metadata', async () => {
    const tarball = makeTarball({ version: '1.2.3' });
    const resolved = await resolveTarget('file-fixture@9.9.9', { file: tarball });

    assert.match(resolved.resolutionError, /Version mismatch/);
    assert.equal(resolved.source, null);
  });

  it('fails closed when no version source exists at all', async () => {
    const tarball = makeTarball({ version: null });
    const resolved = await resolveTarget('file-fixture', { file: tarball });

    assert.match(resolved.resolutionError, /no version metadata/);
    assert.equal(resolved.source, null);
  });

  it('fails closed when the archive SKILL.md name mismatches the command name', async () => {
    const tarball = makeTarball({ version: '1.2.3', skillName: 'other-component' });
    const resolved = await resolveTarget('file-fixture', { file: tarball });

    assert.match(resolved.resolutionError, /name mismatch/i);
    assert.equal(resolved.source, null);
  });

  it('rejects a directory passed to --file', async () => {
    const dir = makeTmpDir();
    const resolved = await resolveTarget('file-fixture', { file: dir });

    assert.match(resolved.resolutionError, /\.tar\.gz archive/);
    assert.equal(resolved.source, null);
  });

  it('rejects a missing --file path', async () => {
    const resolved = await resolveTarget('file-fixture', { file: path.join(makeTmpDir(), 'missing.tar.gz') });

    assert.match(resolved.resolutionError, /Local source not found/);
    assert.equal(resolved.source, null);
  });

  it('rejects a path in place of the component name', async () => {
    const tarball = makeTarball({ version: '1.2.3' });
    const resolved = await resolveTarget('./file-fixture', { file: tarball });

    assert.match(resolved.resolutionError, /requires a component name, not a path/);
    assert.equal(resolved.source, null);
  });

  it('inherits the tarball safety screening from the local-tarball resolver', async () => {
    const root = makeTmpDir();
    const wrapper = path.join(root, 'zylos-file-fixture');
    fs.mkdirSync(wrapper, { recursive: true });
    fs.writeFileSync(path.join(wrapper, 'SKILL.md'), '---\nname: file-fixture\nversion: 1.0.0\n---\n', 'utf8');
    fs.symlinkSync('../../outside', path.join(wrapper, 'escape'));
    const tarball = path.join(root, 'zylos-file-fixture.tar.gz');
    execFileSync('tar', ['czf', tarball, '-C', root, path.basename(wrapper)]);

    const resolved = await resolveTarget('file-fixture', { file: tarball });

    assert.match(resolved.resolutionError, /symbolic or hard link/);
    assert.equal(resolved.source, null);
  });
});
