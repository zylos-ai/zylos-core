import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { smartSync } from '../cli/lib/smart-merge.js';
import {
  generateManifest,
  hashFile,
  loadManifest,
  saveManifest,
  saveMergeBaseline,
  saveOriginals,
} from '../cli/lib/manifest.js';

let tmpRoot;

function mkTmp() {
  return fs.mkdtempSync(path.join(tmpRoot, 'test-'));
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-baseline-boundary-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('smartSync baseline commit boundary', () => {
  test('successful sync returns the source-authoritative candidate without advancing metadata', () => {
    const dest = mkTmp();
    const sourceV1 = mkTmp();
    const sourceV2 = mkTmp();
    writeFile(sourceV1, 'a.js', 'v1');
    writeFile(sourceV2, 'a.js', 'v2');
    saveManifest(dest, generateManifest(sourceV1));
    saveOriginals(dest, sourceV1);
    writeFile(dest, 'a.js', 'v1');

    const before = fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8');
    const result = smartSync(sourceV2, dest);

    assert.deepEqual(result.errors, []);
    assert.equal(result.nextManifest.files['a.js'], hashFile(path.join(sourceV2, 'a.js')));
    assert.equal(fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(dest, '.zylos', 'originals', 'a.js'), 'utf8'), 'v1');
    assert.equal(fs.readFileSync(path.join(dest, 'a.js'), 'utf8'), 'v2');
  });

  test('outer commit advances manifest and originals together', () => {
    const dest = mkTmp();
    const source = mkTmp();
    writeFile(source, 'a.js', 'v2');

    const result = smartSync(source, dest);
    saveMergeBaseline(dest, source, result.nextManifest);

    assert.equal(loadManifest(dest).files['a.js'], hashFile(path.join(source, 'a.js')));
    assert.equal(fs.readFileSync(path.join(dest, '.zylos', 'originals', 'a.js'), 'utf8'), 'v2');
  });

  test('sync error produces no candidate and cannot advance the old baseline', () => {
    const dest = mkTmp();
    const sourceV1 = mkTmp();
    const sourceV2 = mkTmp();
    writeFile(sourceV1, 'a.js', 'v1');
    writeFile(sourceV2, 'a.js', 'v2');
    writeFile(dest, 'a.js', 'v1');
    saveMergeBaseline(dest, sourceV1, generateManifest(sourceV1));
    const before = fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8');

    fs.chmodSync(path.join(dest, 'a.js'), 0o444);
    const result = smartSync(sourceV2, dest);
    fs.chmodSync(path.join(dest, 'a.js'), 0o644);

    assert.ok(result.errors.length > 0);
    assert.equal(result.nextManifest, null);
    assert.equal(fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8'), before);
  });

  test('candidate membership comes only from source, not installed output', () => {
    const dest = mkTmp();
    const source = mkTmp();
    writeFile(dest, 'custom.js', 'user data');
    writeFile(source, 'managed.js', 'package data');

    const result = smartSync(source, dest);

    assert.notEqual(result.nextManifest.files['managed.js'], undefined);
    assert.equal(result.nextManifest.files['custom.js'], undefined);
  });
});
