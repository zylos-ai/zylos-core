import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, it } from 'node:test';

import { archiveCommit } from '../download.js';
import { recordedSource } from '../components.js';

const SHA1 = '0123456789abcdef0123456789abcdef01234567';
const SHA256 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function paxRecord(key, value) {
  const rest = ` ${key}=${value}\n`;
  let length = rest.length + 1;
  while (String(length).length + rest.length !== length) length = String(length).length + rest.length;
  return `${length}${rest}`;
}

function block(header) {
  const buf = Buffer.alloc(512);
  buf.write(header.name, 0, 'latin1');
  buf.write(`${header.size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  buf[156] = header.type.charCodeAt(0);
  buf.write('ustar\0', 257, 'latin1');
  buf.write('00', 263, 'latin1');
  return buf;
}

// A tar.gz whose first entry is a header of `type` carrying `body`, followed by one ordinary file.
function archive(type, body, { gzip = true } = {}) {
  const content = Buffer.from(body, 'utf8');
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  const file = Buffer.alloc(512);
  file.write('hello\n');
  const tar = Buffer.concat([
    block({ name: 'pax_global_header', size: content.length, type }), padded,
    block({ name: 'repo-1.0.0/SKILL.md', size: 6, type: '0' }), file,
    Buffer.alloc(1024),
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-archive-commit-'));
  tmpDirs.push(dir);
  const target = path.join(dir, 'archive.tar.gz');
  fs.writeFileSync(target, gzip ? zlib.gzipSync(tar) : tar);
  return target;
}

describe('archiveCommit reads the commit an archive was made from', () => {
  it('returns the commit named in the pax global header', () => {
    assert.equal(archiveCommit(archive('g', paxRecord('comment', SHA1))), SHA1);
  });

  it('finds the commit after other records and accepts SHA-256 commit ids', () => {
    assert.equal(archiveCommit(archive('g', paxRecord('mtime', '1700000000') + paxRecord('comment', SHA256))), SHA256);
  });

  it('returns null when the archive does not name a commit', () => {
    assert.equal(archiveCommit(archive('g', paxRecord('mtime', '1700000000'))), null, 'global header without comment');
    assert.equal(archiveCommit(archive('x', paxRecord('comment', SHA1))), null, 'per-file header, not a global one');
    assert.equal(archiveCommit(archive('g', paxRecord('comment', 'release build 7'))), null, 'comment that is not a commit id');
    assert.equal(archiveCommit(archive('g', paxRecord('comment', SHA1.slice(0, 12)))), null, 'abbreviated commit id');
  });

  it('returns null for malformed headers and files that are not gzip tar archives', () => {
    assert.equal(archiveCommit(archive('g', `99 comment=${SHA1}\n`)), null, 'record length past the header body');
    assert.equal(archiveCommit(archive('g', `x comment=${SHA1}\n`)), null, 'record length that is not a number');
    assert.equal(archiveCommit(archive('g', paxRecord('comment', SHA1), { gzip: false })), null, 'uncompressed tar');
    const dir = path.dirname(archive('g', ''));
    const text = path.join(dir, 'notes.tar.gz');
    fs.writeFileSync(text, 'not an archive');
    assert.equal(archiveCommit(text), null);
    assert.equal(archiveCommit(path.join(dir, 'missing.tar.gz')), null);
  });
});

describe('recordedSource describes the code an install or upgrade put on the machine', () => {
  const requested = { type: 'github-release', repo: 'example/zylos-x', ref: '1.0.0', refType: 'tag' };

  it('records the ref and commit the download reports', () => {
    assert.deepEqual(
      recordedSource(requested, { ref: 'main', refType: 'branch', commit: SHA1 }),
      { type: 'github-release', repo: 'example/zylos-x', ref: 'main', refType: 'branch', commit: SHA1 },
    );
  });

  it('names the release tag and an unknown commit when the download reports neither', () => {
    assert.deepEqual(
      recordedSource(requested, {}),
      { type: 'github-release', repo: 'example/zylos-x', ref: 'v1.0.0', refType: 'tag', commit: null },
    );
    assert.deepEqual(
      recordedSource({ ...requested, ref: 'feat/y', refType: 'branch', commit: SHA1 }),
      { type: 'github-release', repo: 'example/zylos-x', ref: 'feat/y', refType: 'branch', commit: null },
      'a commit already in the requested source is not carried over',
    );
  });

  it('keeps a local source as it is and adds the commit its archive names', () => {
    assert.deepEqual(
      recordedSource({ type: 'local-tarball', path: '/srv/x.tar.gz' }, { commit: SHA1 }),
      { type: 'local-tarball', path: '/srv/x.tar.gz', commit: SHA1 },
    );
    assert.deepEqual(
      recordedSource({ type: 'local-dir', path: '/srv/x' }, { success: true, extractedDir: '/srv/x' }),
      { type: 'local-dir', path: '/srv/x', commit: null },
    );
  });
});
