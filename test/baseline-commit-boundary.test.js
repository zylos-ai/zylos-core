import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
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

describe('smartSync baseline commit boundary (#715)', () => {
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

    expect(result.errors).toEqual([]);
    expect(result.nextManifest.files['a.js']).toBe(hashFile(path.join(sourceV2, 'a.js')));
    expect(fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(dest, '.zylos', 'originals', 'a.js'), 'utf8')).toBe('v1');
    expect(fs.readFileSync(path.join(dest, 'a.js'), 'utf8')).toBe('v2');
  });

  test('outer commit advances manifest and originals together', () => {
    const dest = mkTmp();
    const source = mkTmp();
    writeFile(source, 'a.js', 'v2');

    const result = smartSync(source, dest);
    saveMergeBaseline(dest, source, result.nextManifest);

    expect(loadManifest(dest).files['a.js']).toBe(hashFile(path.join(source, 'a.js')));
    expect(fs.readFileSync(path.join(dest, '.zylos', 'originals', 'a.js'), 'utf8')).toBe('v2');
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

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.nextManifest).toBeNull();
    expect(fs.readFileSync(path.join(dest, '.zylos', 'manifest.json'), 'utf8')).toBe(before);
  });

  test('candidate membership comes only from source, not installed output', () => {
    const dest = mkTmp();
    const source = mkTmp();
    writeFile(dest, 'custom.js', 'user data');
    writeFile(source, 'managed.js', 'package data');

    const result = smartSync(source, dest);

    expect(result.nextManifest.files['managed.js']).toBeDefined();
    expect(result.nextManifest.files['custom.js']).toBeUndefined();
  });
});
