import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.deepEqual(Object.keys(manifest.files).sort(), ['a.js', 'b.js', 'sub/c.js']);
    assert.ok(manifest.generated_at);
  });

  test('excludes .zylos, node_modules, .git, .backup directories', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');
    writeFile(dir, '.zylos/manifest.json', '{}');
    writeFile(dir, 'node_modules/pkg/index.js', 'mod');
    writeFile(dir, '.git/HEAD', 'ref');
    writeFile(dir, '.backup/old/a.js', 'old');

    const manifest = generateManifest(dir);
    assert.deepEqual(Object.keys(manifest.files), ['a.js']);
  });

  test('produces deterministic hashes', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');

    const m1 = generateManifest(dir);
    const m2 = generateManifest(dir);
    assert.equal(m1.files['a.js'], m2.files['a.js']);
  });

  test('different content produces different hashes', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content-v1');
    const m1 = generateManifest(dir);

    writeFile(dir, 'a.js', 'content-v2');
    const m2 = generateManifest(dir);

    assert.notEqual(m1.files['a.js'], m2.files['a.js']);
  });
});

describe('saveManifest / loadManifest', () => {
  test('roundtrip: save and load', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');

    const manifest = generateManifest(dir);
    saveManifest(dir, manifest);

    const loaded = loadManifest(dir);
    assert.deepEqual(loaded.files, manifest.files);
  });

  test('returns null when no manifest exists', () => {
    const dir = mkTmp();
    assert.equal(loadManifest(dir), null);
  });
});

describe('originals', () => {
  test('saveOriginals stores copies, getOriginalContent retrieves them', () => {
    const component = mkTmp();
    const source = mkTmp();

    writeFile(source, 'a.js', 'original-content');
    writeFile(source, 'sub/b.js', 'sub-content');

    saveOriginals(component, source);

    assert.equal(hasOriginals(component), true);
    assert.equal(getOriginalContent(component, 'a.js'), 'original-content');
    assert.equal(getOriginalContent(component, 'sub/b.js'), 'sub-content');
  });

  test('hasOriginals returns false when no originals', () => {
    const dir = mkTmp();
    assert.equal(hasOriginals(dir), false);
  });

  test('getOriginalContent returns null for missing file', () => {
    const dir = mkTmp();
    assert.equal(getOriginalContent(dir, 'nonexistent.js'), null);
  });

  test('saveOriginals replaces previous originals', () => {
    const component = mkTmp();
    const source1 = mkTmp();
    const source2 = mkTmp();

    writeFile(source1, 'a.js', 'v1');
    saveOriginals(component, source1);

    writeFile(source2, 'a.js', 'v2');
    saveOriginals(component, source2);

    assert.equal(getOriginalContent(component, 'a.js'), 'v2');
  });
});

describe('saveMergeBaseline', () => {
  test('commits manifest and originals together on success', () => {
    const component = mkTmp();
    const source = mkTmp();

    writeFile(source, 'a.js', 'new-content');
    const manifest = generateManifest(source);

    saveMergeBaseline(component, source, manifest);

    assert.equal(loadManifest(component).files['a.js'], manifest.files['a.js']);
    assert.equal(getOriginalContent(component, 'a.js'), 'new-content');
    assert.equal(fs.existsSync(path.join(component, '.zylos', 'originals.bak')), false);
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
    assert.throws(() => saveMergeBaseline(component, missingSource, { files: {}, generated_at: 'x' }));

    // Live pair still the v1 baseline, byte-identical manifest, no staging left
    assert.equal(fs.readFileSync(path.join(component, '.zylos', 'manifest.json'), 'utf8'), manifestBefore);
    assert.equal(getOriginalContent(component, 'a.js'), 'v1');
    assert.equal(fs.existsSync(path.join(component, '.zylos', 'manifest.json.tmp')), false);
    assert.equal(fs.existsSync(path.join(component, '.zylos', 'originals.new')), false);
  });

  test('staging-failure cleanup interrupted midway keeps the transaction visibly uncommitted', () => {
    const component = mkTmp();
    const sourceV1 = mkTmp();
    const sourceV2 = mkTmp();

    // Previous baseline: manifest + originals v1
    writeFile(sourceV1, 'a.js', 'v1');
    saveManifest(component, generateManifest(sourceV1));
    saveOriginals(component, sourceV1);
    const manifestBefore = fs.readFileSync(path.join(component, '.zylos', 'manifest.json'), 'utf8');

    writeFile(sourceV2, 'a.js', 'v2');
    const manifestV2 = generateManifest(sourceV2);

    // Fault injection: the commit rename fails (forcing the catch cleanup),
    // and the cleanup itself is interrupted by an I/O error on its SECOND
    // deletion — the window between the two cleanup steps
    const realRename = fs.renameSync;
    const realUnlink = fs.unlinkSync;
    let markerRemovalAttempts = 0;
    fs.renameSync = () => {
      const err = new Error('EIO: injected commit failure');
      err.code = 'EIO';
      throw err;
    };
    fs.unlinkSync = (...args) => {
      if (path.basename(args[0]) === 'manifest.json.tmp') {
        markerRemovalAttempts++;
        const err = new Error('EIO: injected cleanup interruption');
        err.code = 'EIO';
        throw err;
      }
      return realUnlink(...args);
    };
    try {
      assert.throws(() => saveMergeBaseline(component, sourceV2, manifestV2), /EIO/);
      assert.equal(markerRemovalAttempts, 1);
    } finally {
      fs.renameSync = realRename;
      fs.unlinkSync = realUnlink;
    }

    // Whatever the interruption left behind, recovery must restore the OLD
    // generation — the transaction never committed, so no staged artifact may
    // ever surface as live. Double-run to pin idempotence.
    for (let run = 0; run < 2; run++) {
      recoverMergeBaseline(component);
      assert.equal(fs.readFileSync(path.join(component, '.zylos', 'manifest.json'), 'utf8'), manifestBefore);
      assert.equal(getOriginalContent(component, 'a.js'), 'v1');
      assert.equal(fs.existsSync(path.join(component, '.zylos', 'manifest.json.tmp')), false);
      assert.equal(fs.existsSync(path.join(component, '.zylos', 'originals.new')), false);
    }
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
      assert.equal(fs.existsSync(path.join(component, '.zylos', 'manifest.json.tmp')), false);
      assert.equal(fs.existsSync(path.join(component, '.zylos', 'originals.new')), false);
      assert.equal(fs.readFileSync(path.join(component, '.zylos', 'manifest.json'), 'utf8'), manifestBefore);
      assert.equal(getOriginalContent(component, 'a.js'), 'v1');
    }
  });

  test('rollback interrupted between its two deletions cannot surface the uncommitted staging', () => {
    const component = mkTmp();
    setupBaseline(component);
    const manifestBefore = fs.readFileSync(path.join(component, '.zylos', 'manifest.json'), 'utf8');

    // Uncommitted transaction on disk: staged manifest (the transaction
    // marker) + staged originals, as left by a crash during staging
    writeFile(component, '.zylos/manifest.json.tmp', '{"files":{"a.js":"deadbeef"}}');
    writeFile(component, '.zylos/originals.new/a.js', 'v2-staged-uncommitted');

    // Fault injection: the SECOND deletion inside this recovery run fails
    // (EIO) — an interruption in the window between the two cleanup steps
    const realUnlink = fs.unlinkSync;
    let markerRemovalAttempts = 0;
    fs.unlinkSync = (...args) => {
      if (path.basename(args[0]) === 'manifest.json.tmp') {
        markerRemovalAttempts++;
        const err = new Error('EIO: injected recovery interruption');
        err.code = 'EIO';
        throw err;
      }
      return realUnlink(...args);
    };
    try {
      assert.throws(() => recoverMergeBaseline(component), /EIO/);
      assert.equal(markerRemovalAttempts, 1);
    } finally {
      fs.unlinkSync = realUnlink;
    }

    // Re-run recovery (injection gone). The interrupted rollback must still
    // converge to the OLD generation: the staged originals were never
    // committed and must not be mistaken for a committed swap and rolled
    // forward. Double-run to pin idempotence.
    for (let run = 0; run < 2; run++) {
      recoverMergeBaseline(component);
      assert.equal(fs.readFileSync(path.join(component, '.zylos', 'manifest.json'), 'utf8'), manifestBefore);
      assert.equal(getOriginalContent(component, 'a.js'), 'v1');
      assert.equal(fs.existsSync(path.join(component, '.zylos', 'manifest.json.tmp')), false);
      assert.equal(fs.existsSync(path.join(component, '.zylos', 'originals.new')), false);
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
      assert.equal(fs.existsSync(path.join(component, '.zylos', 'originals.new')), false);
      assert.equal(getOriginalContent(component, 'a.js'), 'v2');
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
    assert.equal(fs.existsSync(path.join(component, '.zylos', 'originals.bak')), false);
    assert.equal(getOriginalContent(component, 'a.js'), 'v1');
  });

  test('legacy bak matching the manifest is restored when live originals are broken', () => {
    const component = mkTmp();
    setupBaseline(component, 'v1');

    // Corrupt the live originals; move the correct copy into the legacy bak
    writeFile(component, '.zylos/originals.bak/a.js', 'v1');
    writeFile(component, '.zylos/originals/a.js', 'partial garbage');

    recoverMergeBaseline(component);
    assert.equal(getOriginalContent(component, 'a.js'), 'v1');
    assert.equal(fs.existsSync(path.join(component, '.zylos', 'originals.bak')), false);
  });

  test('legacy bak where neither side matches: explicit error, site preserved', () => {
    const component = mkTmp();
    setupBaseline(component, 'v1');

    writeFile(component, '.zylos/originals/a.js', 'garbage-active');
    writeFile(component, '.zylos/originals.bak/a.js', 'garbage-bak');

    assert.throws(() => recoverMergeBaseline(component), /manual inspection/);
    // Nothing deleted — both candidates preserved for inspection
    assert.equal(fs.readFileSync(path.join(component, '.zylos', 'originals', 'a.js'), 'utf8'), 'garbage-active');
    assert.equal(fs.readFileSync(path.join(component, '.zylos', 'originals.bak', 'a.js'), 'utf8'), 'garbage-bak');
  });

  test('no-op on a clean baseline and on a missing .zylos dir', () => {
    const clean = mkTmp();
    setupBaseline(clean);
    const manifestBefore = fs.readFileSync(path.join(clean, '.zylos', 'manifest.json'), 'utf8');
    recoverMergeBaseline(clean);
    assert.equal(fs.readFileSync(path.join(clean, '.zylos', 'manifest.json'), 'utf8'), manifestBefore);
    assert.equal(getOriginalContent(clean, 'a.js'), 'v1');

    const empty = mkTmp();
    assert.doesNotThrow(() => recoverMergeBaseline(empty));
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
    assert.ok(changes.modified.includes('a.js'));
    assert.equal(changes.unchanged.length, 0);
  });

  test('detects added files', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'original');

    const manifest = generateManifest(dir);
    saveManifest(dir, manifest);

    writeFile(dir, 'b.js', 'new file');

    const changes = detectChanges(dir);
    assert.ok(changes.added.includes('b.js'));
  });

  test('detects deleted files', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');
    writeFile(dir, 'b.js', 'content');

    const manifest = generateManifest(dir);
    saveManifest(dir, manifest);

    fs.unlinkSync(path.join(dir, 'b.js'));

    const changes = detectChanges(dir);
    assert.ok(changes.deleted.includes('b.js'));
  });

  test('detects unchanged files', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');

    const manifest = generateManifest(dir);
    saveManifest(dir, manifest);

    const changes = detectChanges(dir);
    assert.ok(changes.unchanged.includes('a.js'));
    assert.equal(changes.modified.length, 0);
  });

  test('returns null when no manifest exists', () => {
    const dir = mkTmp();
    writeFile(dir, 'a.js', 'content');

    const changes = detectChanges(dir);
    assert.equal(changes, null);
  });
});

// Recovery must preserve its transaction marker when a staged deletion is unsafe.
test('baseline recovery rejects a linked staged originals directory before removing its marker', () => {
  const component = mkTmp(), outside = mkTmp();
  fs.mkdirSync(path.join(component, '.zylos'));
  writeFile(outside, 'keep.txt', 'outside contents');
  writeFile(component, '.zylos/manifest.json.tmp', '{"files":{}}');
  fs.symlinkSync(outside, path.join(component, '.zylos/originals.new'));
  assert.throws(() => recoverMergeBaseline(component));
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside contents');
  assert.equal(fs.existsSync(path.join(component, '.zylos/manifest.json.tmp')), true);
  assert.equal(fs.lstatSync(path.join(component, '.zylos/originals.new')).isSymbolicLink(), true);
});

test('baseline helpers preserve absent component creation and recovery no-op behavior', () => {
  const parent = mkTmp(), source = mkTmp();
  const absent = path.join(parent, 'absent');
  assert.doesNotThrow(() => recoverMergeBaseline(absent));
  assert.equal(fs.existsSync(absent), false);
  writeFile(source, 'entry.txt', 'source contents');
  const originalsOnly = path.join(parent, 'originals-only');
  saveOriginals(originalsOnly, source);
  assert.equal(getOriginalContent(originalsOnly, 'entry.txt'), 'source contents');
  const merged = path.join(parent, 'merged');
  saveMergeBaseline(merged, source, generateManifest(source));
  assert.equal(getOriginalContent(merged, 'entry.txt'), 'source contents');
  assert.deepEqual(loadManifest(merged).files, generateManifest(source).files);
});
