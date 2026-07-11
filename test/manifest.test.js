import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateManifest,
  saveManifest,
  loadManifest,
  saveOriginals,
  saveMergeBaseline,
  recoverMergeBaseline,
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

describe('saveMergeBaseline', () => {
  test('commits manifest and originals together on success', () => {
    const component = mkTmp();
    const source = mkTmp();

    writeFile(source, 'a.js', 'new-content');
    const manifest = generateManifest(source);

    saveMergeBaseline(component, source, manifest);

    expect(loadManifest(component).files['a.js']).toBe(manifest.files['a.js']);
    expect(getOriginalContent(component, 'a.js')).toBe('new-content');
    expect(fs.existsSync(path.join(component, '.zylos', 'originals.bak'))).toBe(false);
  });

  test('originals staging failure leaves the live baseline pair untouched', () => {
    const component = mkTmp();
    const sourceV1 = mkTmp();

    // Previous baseline: manifest + originals v1
    writeFile(sourceV1, 'a.js', 'v1');
    const manifestV1 = generateManifest(sourceV1);
    saveManifest(component, manifestV1);
    saveOriginals(component, sourceV1);
    const manifestBefore = fs.readFileSync(path.join(component, '.zylos', 'manifest.json'), 'utf8');

    // A nonexistent source makes originals staging fail after the staged
    // manifest was written — the commit rename is never reached
    const missingSource = path.join(tmpRoot, 'does-not-exist');
    expect(() => saveMergeBaseline(component, missingSource, { files: {}, generated_at: 'x' }))
      .toThrow();

    // Live pair still the v1 baseline, byte-identical manifest, no staging left
    expect(fs.readFileSync(path.join(component, '.zylos', 'manifest.json'), 'utf8')).toBe(manifestBefore);
    expect(getOriginalContent(component, 'a.js')).toBe('v1');
    expect(fs.existsSync(path.join(component, '.zylos', 'manifest.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(component, '.zylos', 'originals.new'))).toBe(false);
  });
});

describe('recoverMergeBaseline', () => {
  // Build a committed v1 baseline: manifest + originals from sourceV1
  function setupBaseline(component, content = 'v1') {
    const source = mkTmp();
    writeFile(source, 'a.js', content);
    saveManifest(component, generateManifest(source));
    saveOriginals(component, source);
    return source;
  }

  test('uncommitted staged transaction rolls back — idempotently', () => {
    const component = mkTmp();
    setupBaseline(component);
    const manifestBefore = fs.readFileSync(path.join(component, '.zylos', 'manifest.json'), 'utf8');

    writeFile(component, '.zylos/manifest.json.tmp', '{"files":{"bogus.js":"dead"}}');
    writeFile(component, '.zylos/originals.new/bogus.js', 'staged junk');

    for (let run = 0; run < 2; run++) {
      recoverMergeBaseline(component);
      expect(fs.existsSync(path.join(component, '.zylos', 'manifest.json.tmp'))).toBe(false);
      expect(fs.existsSync(path.join(component, '.zylos', 'originals.new'))).toBe(false);
      expect(fs.readFileSync(path.join(component, '.zylos', 'manifest.json'), 'utf8')).toBe(manifestBefore);
      expect(getOriginalContent(component, 'a.js')).toBe('v1');
    }
  });

  test('committed transaction with interrupted swap rolls forward — idempotently', () => {
    const component = mkTmp();
    setupBaseline(component, 'v1');

    // Simulate: manifest already committed to v2, originals swap interrupted
    const sourceV2 = mkTmp();
    writeFile(sourceV2, 'a.js', 'v2');
    saveManifest(component, generateManifest(sourceV2));
    writeFile(component, '.zylos/originals.new/a.js', 'v2');

    for (let run = 0; run < 2; run++) {
      recoverMergeBaseline(component);
      expect(fs.existsSync(path.join(component, '.zylos', 'originals.new'))).toBe(false);
      expect(getOriginalContent(component, 'a.js')).toBe('v2');
    }
  });

  test('legacy bak with matching live originals is dropped — local file edits do not trigger recovery', () => {
    const component = mkTmp();
    setupBaseline(component, 'v1');

    // Live installed file legitimately modified by the user — must NOT
    // participate in the consistency check
    writeFile(component, 'a.js', 'locally modified');

    // Stale legacy backup from an older generation
    writeFile(component, '.zylos/originals.bak/a.js', 'v0');

    recoverMergeBaseline(component);
    expect(fs.existsSync(path.join(component, '.zylos', 'originals.bak'))).toBe(false);
    expect(getOriginalContent(component, 'a.js')).toBe('v1');
  });

  test('legacy bak matching the manifest is restored when live originals are broken', () => {
    const component = mkTmp();
    setupBaseline(component, 'v1');

    // Corrupt the live originals; move the correct copy into the legacy bak
    writeFile(component, '.zylos/originals.bak/a.js', 'v1');
    writeFile(component, '.zylos/originals/a.js', 'partial garbage');

    recoverMergeBaseline(component);
    expect(getOriginalContent(component, 'a.js')).toBe('v1');
    expect(fs.existsSync(path.join(component, '.zylos', 'originals.bak'))).toBe(false);
  });

  test('legacy bak where neither side matches: explicit error, site preserved', () => {
    const component = mkTmp();
    setupBaseline(component, 'v1');

    writeFile(component, '.zylos/originals/a.js', 'garbage-active');
    writeFile(component, '.zylos/originals.bak/a.js', 'garbage-bak');

    expect(() => recoverMergeBaseline(component)).toThrow(/manual inspection/);
    // Nothing deleted — both candidates preserved for inspection
    expect(fs.readFileSync(path.join(component, '.zylos', 'originals', 'a.js'), 'utf8')).toBe('garbage-active');
    expect(fs.readFileSync(path.join(component, '.zylos', 'originals.bak', 'a.js'), 'utf8')).toBe('garbage-bak');
  });

  test('no-op on a clean baseline and on a missing .zylos dir', () => {
    const clean = mkTmp();
    setupBaseline(clean);
    const manifestBefore = fs.readFileSync(path.join(clean, '.zylos', 'manifest.json'), 'utf8');
    recoverMergeBaseline(clean);
    expect(fs.readFileSync(path.join(clean, '.zylos', 'manifest.json'), 'utf8')).toBe(manifestBefore);
    expect(getOriginalContent(clean, 'a.js')).toBe('v1');

    const empty = mkTmp();
    expect(() => recoverMergeBaseline(empty)).not.toThrow();
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
