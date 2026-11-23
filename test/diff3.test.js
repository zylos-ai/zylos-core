import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isDiff3Available, merge3 } from '../cli/lib/diff3.js';

describe('isDiff3Available', () => {
  test('returns true when diff3 is installed', () => {
    assert.equal(isDiff3Available(), true);
  });
});

describe('merge3', () => {
  test('clean merge: only local changed', () => {
    const base = 'line1\nline2\nline3\n';
    const local = 'line1\nmodified\nline3\n';
    const remote = 'line1\nline2\nline3\n';

    const result = merge3(base, local, remote);
    assert.equal(result.clean, true);
    assert.equal(result.content, 'line1\nmodified\nline3\n');
  });

  test('clean merge: only remote changed', () => {
    const base = 'line1\nline2\nline3\n';
    const local = 'line1\nline2\nline3\n';
    const remote = 'line1\nline2\nnew-line3\n';

    const result = merge3(base, local, remote);
    assert.equal(result.clean, true);
    assert.equal(result.content, 'line1\nline2\nnew-line3\n');
  });

  test('clean merge: both changed different sections', () => {
    const base = 'a\nb\nc\nd\ne\n';
    const local = 'a\nB\nc\nd\ne\n';
    const remote = 'a\nb\nc\nd\nE\n';

    const result = merge3(base, local, remote);
    assert.equal(result.clean, true);
    assert.equal(result.content, 'a\nB\nc\nd\nE\n');
  });

  test('conflict: both changed same line', () => {
    const base = 'line1\nline2\nline3\n';
    const local = 'line1\nlocal-change\nline3\n';
    const remote = 'line1\nremote-change\nline3\n';

    const result = merge3(base, local, remote);
    assert.equal(result.clean, false);
    assert.ok(result.content.includes('<<<<<<<'));
    assert.ok(result.content.includes('>>>>>>>'));
  });

  test('identical content: no changes', () => {
    const content = 'same\ncontent\nhere\n';

    const result = merge3(content, content, content);
    assert.equal(result.clean, true);
    assert.equal(result.content, content);
  });

  test('handles empty base (all content is new)', () => {
    const base = '';
    const local = 'local content\n';
    const remote = 'remote content\n';

    const result = merge3(base, local, remote);
    // Both added content to empty base — likely a conflict
    assert.equal(result.clean, false);
  });

  test('handles multiline additions', () => {
    const base = 'start\nend\n';
    const local = 'start\nlocal-added\nend\n';
    const remote = 'start\nend\nremote-added\n';

    const result = merge3(base, local, remote);
    assert.equal(result.clean, true);
    assert.ok(result.content.includes('local-added'));
    assert.ok(result.content.includes('remote-added'));
  });
});
