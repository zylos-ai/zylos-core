import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activateFreshSplitInstructions,
  assertInstructionReady,
  buildInstructionFile,
  instructionFormatVersionPath,
  instructionPaths,
  needsRebuild,
  readInstructionFormatVersion,
  refreshSplitInstructions,
  writeInstructionFormatVersion,
} from '../runtime/instruction-builder.js';
import {
  assembleInstruction,
  needsRebuild as leafNeedsRebuild,
} from '../runtime/assembler.mjs';
import { runMigrations } from '../migrate.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-split-test-'));
}

function leftovers(root) {
  const found = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.name.includes('.split-txn.') || entry.name.includes('.split-render.')) found.push(filePath);
    }
  }
  walk(root);
  return found;
}

describe('instruction format version protocol', () => {
  it('distinguishes missing, valid and invalid values and round-trips atomically', () => {
    const root = fixture();
    assert.deepEqual(
      readInstructionFormatVersion({ zylosDir: root }),
      { version: null, valid: true, exists: false, filePath: instructionFormatVersionPath({ zylosDir: root }) },
    );
    for (const version of [1, 2, 3]) {
      writeInstructionFormatVersion({ zylosDir: root, version });
      assert.equal(fs.readFileSync(instructionFormatVersionPath({ zylosDir: root }), 'utf8'), `${version}\n`);
      assert.equal(readInstructionFormatVersion({ zylosDir: root }).version, version);
    }
    for (const invalid of ['', '0\n', '-1\n', '2.5\n', ' 2\n', `${Number.MAX_SAFE_INTEGER}0\n`, 'wat\n']) {
      fs.writeFileSync(instructionFormatVersionPath({ zylosDir: root }), invalid);
      const state = readInstructionFormatVersion({ zylosDir: root });
      assert.equal(state.valid, false);
      assert.equal(state.version, null);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

});

describe('split instruction assembler', () => {

  it('writes source header and rebuilds only when an input is newer', () => {
    const root = fixture();
    const systemPath = path.join(root, 'system.md');
    const userPath = path.join(root, 'user.md');
    const outputPath = path.join(root, 'output.md');
    fs.writeFileSync(systemPath, 'SYSTEM\n');
    fs.writeFileSync(userPath, 'USER\n');
    assert.equal(leafNeedsRebuild({ systemPath, userPath, outputPath }), true);
    assembleInstruction({ systemPath, userPath, outputPath });
    const output = fs.readFileSync(outputPath, 'utf8');
    assert.match(output, /zylos-generated:split-v1/);
    assert.match(output, new RegExp(`system: ${systemPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, /SYSTEM\n\nUSER/);
    assert.equal(leafNeedsRebuild({ systemPath, userPath, outputPath }), false);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(userPath, future, future);
    assert.equal(leafNeedsRebuild({ systemPath, userPath, outputPath }), true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const legacyClass of ['A-byte-identical', 'B-pure-add', 'C-diverged']) {
    it(`strictly preserves no-marker ${legacyClass} outputs`, () => {
      const root = fixture();
      fs.writeFileSync(path.join(root, 'ZYLOS.md'), `${legacyClass} user\n`);
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), `${legacyClass} claude bytes\n`);
      fs.writeFileSync(path.join(root, 'AGENTS.md'), `${legacyClass} agents bytes\n`);
      const before = ['ZYLOS.md', 'CLAUDE.md', 'AGENTS.md'].map(name => fs.readFileSync(path.join(root, name)));
      const result = refreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
      assert.equal(result.pendingMigration, true);
      assert.equal(needsRebuild('claude', { zylosDir: root }), false);
      buildInstructionFile('claude', { zylosDir: root, force: true });
      ['ZYLOS.md', 'CLAUDE.md', 'AGENTS.md'].forEach((name, index) => {
        assert.deepEqual(fs.readFileSync(path.join(root, name)), before[index]);
      });
      assert.ok(fs.existsSync(instructionPaths('claude', { zylosDir: root }).assemblerPath));
      assert.equal(fs.existsSync(path.join(root, '.zylos/instructions/onboarding.md')), false);
      fs.rmSync(root, { recursive: true, force: true });
    });
  }

  it('rejects an active launch boundary until the generation is prepared', () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const userPath = instructionPaths('codex', { zylosDir: root }).userPath;
    fs.appendFileSync(userPath, '\nchanged\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(userPath, future, future);
    assert.throws(() => assertInstructionReady('codex', { zylosDir: root }), /not prepared before launch/);
    // Keep the restored source timestamp strictly behind the regenerated
    // output, avoiding filesystem/Date millisecond rounding at this boundary.
    const current = new Date(Date.now() - 1000);
    fs.utimesSync(userPath, current, current);
    buildInstructionFile('codex', { zylosDir: root });
    assert.equal(assertInstructionReady('codex', { zylosDir: root }), true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('fresh split activation transaction', () => {

  const faultPoints = [
    'stage:claude-system', 'stage:codex-system', 'stage:assembler', 'stage:seed',
    'stage:claude-output', 'stage:codex-output', 'stage:marker',
    'rename:claude-system', 'rename:codex-system', 'rename:assembler', 'rename:seed',
    'rename:claude-output', 'rename:codex-output', 'rename:marker',
  ];

  for (const point of faultPoints) {
    it(`rolls back ${point} and succeeds on retry`, () => {
      const root = fixture();
      assert.throws(() => activateFreshSplitInstructions({
        zylosDir: root,
        templatesDir: TEMPLATES_DIR,
        faultInjector(current) { if (current === point) throw new Error(`fault:${point}`); },
      }), new RegExp(`fault:${point}`));
      const paths = instructionPaths('claude', { zylosDir: root });
      assert.equal(fs.existsSync(paths.markerPath), false);
      assert.equal(fs.existsSync(paths.outputPath), false);
      assert.equal(fs.existsSync(instructionPaths('codex', { zylosDir: root }).outputPath), false);
      assert.deepEqual(leftovers(root), []);
      activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
      assert.equal(fs.existsSync(paths.markerPath), true);
      assert.equal(fs.existsSync(paths.outputPath), true);
      assert.equal(fs.existsSync(instructionPaths('codex', { zylosDir: root }).outputPath), true);
      assert.deepEqual(leftovers(root), []);
      fs.rmSync(root, { recursive: true, force: true });
    });
  }


  it('recovers a hard-killed active refresh while leaving the live marker in place', () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('claude', { zylosDir: root });
    const markerBefore = fs.readFileSync(paths.markerPath);
    const systemBefore = fs.readFileSync(paths.systemPath);
    const token = '9999.123456.deadbeef';
    fs.renameSync(paths.systemPath, `${paths.systemPath}.split-txn.${token}.bak`);
    fs.writeFileSync(paths.systemPath, 'partially applied generation\n');
    fs.writeFileSync(`${paths.markerPath}.split-txn.${token}`, JSON.stringify({ transactionId: token }));

    assert.deepEqual(fs.readFileSync(paths.markerPath), markerBefore);
    const result = refreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.equal(result.active, true);
    assert.deepEqual(fs.readFileSync(paths.systemPath), systemBefore);
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves user content on active re-init and repairs a missing materialized assembler', () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('claude', { zylosDir: root });
    const user = Buffer.from('user-owned re-init sentinel\n');
    fs.writeFileSync(paths.userPath, user);
    fs.unlinkSync(paths.assemblerPath);
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.deepEqual(fs.readFileSync(paths.userPath), user);
    assert.ok(fs.existsSync(paths.assemblerPath));
    fs.rmSync(root, { recursive: true, force: true });
  });

});

describe('pre-v0.4 migration', () => {

  it('uses an explicit root, preserves CLAUDE.md, and does not activate split mode', async () => {
    const root = fixture();
    const legacy = Buffer.from('# Legacy\ncustom\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), legacy);
    const result = await runMigrations({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.ok(result.migrated.includes('v0.4.0/claude-md-to-zylos-md'));
    assert.deepEqual(fs.readFileSync(path.join(root, 'CLAUDE.md')), legacy);
    assert.ok(fs.readFileSync(path.join(root, 'ZYLOS.md'), 'utf8').endsWith(legacy.toString()));
    assert.equal(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

});
