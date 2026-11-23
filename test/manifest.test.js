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
