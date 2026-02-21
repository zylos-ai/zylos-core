import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateManifest,
  saveManifest,
  loadManifest,
  saveOriginals,
  getOriginalContent,
  hasOriginals,
  detectChanges,
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-manifest-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('generateManifest', () => {
  test('generates hashes for all files', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content-a');
    writeFile(dir, 'b.js', 'content-b');
    writeFile(dir, 'sub/c.js', 'content-c');

    const manifest = generateManifest(dir);
    expect(Object.keys(manifest.files).sort()).toEqual(['a.js', 'b.js', 'sub/c.js']);
    expect(manifest.generated_at).toBeTruthy();
  });

  test('excludes .zylos, node_modules, .git, .backup directories', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');
    writeFile(dir, '.zylos/manifest.json', '{}');
    writeFile(dir, 'node_modules/pkg/index.js', 'mod');
    writeFile(dir, '.git/HEAD', 'ref');
    writeFile(dir, '.backup/old/a.js', 'old');

    const manifest = generateManifest(dir);
    expect(Object.keys(manifest.files)).toEqual(['a.js']);
  });

  test('produces deterministic hashes', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');

    const m1 = generateManifest(dir);
    const m2 = generateManifest(dir);
    expect(m1.files['a.js']).toBe(m2.files['a.js']);
  });

  test('different content produces different hashes', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content-v1');
    const m1 = generateManifest(dir);

    writeFile(dir, 'a.js', 'content-v2');
    const m2 = generateManifest(dir);

    expect(m1.files['a.js']).not.toBe(m2.files['a.js']);
  });
});

describe('saveManifest / loadManifest', () => {
  test('roundtrip: save and load', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');

    const manifest = generateManifest(dir);
    saveManifest(dir, manifest);

    const loaded = loadManifest(dir);
    expect(loaded.files).toEqual(manifest.files);
  });

  test('returns null when no manifest exists', () => {
    const dir = mkTmp();
    expect(loadManifest(dir)).toBeNull();
  });
});

describe('originals', () => {
  test('saveOriginals stores copies, getOriginalContent retrieves them', () => {
    const component = mkTmp();
    const source = mkTmp();

    writeFile(source, 'a.js', 'original-content');
    writeFile(source, 'sub/b.js', 'sub-content');

    saveOriginals(component, source);

    expect(hasOriginals(component)).toBe(true);
    expect(getOriginalContent(component, 'a.js')).toBe('original-content');
    expect(getOriginalContent(component, 'sub/b.js')).toBe('sub-content');
  });

  test('hasOriginals returns false when no originals', () => {
    const dir = mkTmp();
    expect(hasOriginals(dir)).toBe(false);
  });

  test('getOriginalContent returns null for missing file', () => {
    const dir = mkTmp();
    expect(getOriginalContent(dir, 'nonexistent.js')).toBeNull();
  });

  test('saveOriginals replaces previous originals', () => {
    const component = mkTmp();
    const source1 = mkTmp();
    const source2 = mkTmp();

    writeFile(source1, 'a.js', 'v1');
    saveOriginals(component, source1);

    writeFile(source2, 'a.js', 'v2');
    saveOriginals(component, source2);

    expect(getOriginalContent(component, 'a.js')).toBe('v2');
  });
});

describe('detectChanges', () => {
  test('detects modified files', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'original');

    const manifest = generateManifest(dir);
    saveManifest(dir, manifest);

    writeFile(dir, 'a.js', 'modified');

    const changes = detectChanges(dir);
    expect(changes.modified).toContain('a.js');
    expect(changes.unchanged.length).toBe(0);
  });

  test('detects added files', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'original');

    const manifest = generateManifest(dir);
    saveManifest(dir, manifest);

    writeFile(dir, 'b.js', 'new file');

    const changes = detectChanges(dir);
    expect(changes.added).toContain('b.js');
  });

  test('detects deleted files', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');
    writeFile(dir, 'b.js', 'content');

    const manifest = generateManifest(dir);
    saveManifest(dir, manifest);

    fs.unlinkSync(path.join(dir, 'b.js'));

    const changes = detectChanges(dir);
    expect(changes.deleted).toContain('b.js');
  });

  test('detects unchanged files', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');

    const manifest = generateManifest(dir);
    saveManifest(dir, manifest);

    const changes = detectChanges(dir);
    expect(changes.unchanged).toContain('a.js');
    expect(changes.modified.length).toBe(0);
  });

  test('returns null when no manifest exists', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');

    const changes = detectChanges(dir);
    expect(changes).toBeNull();
  });
});
