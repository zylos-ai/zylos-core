import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  activateFreshSplitInstructions,
  assertInstructionReady,
  buildInstructionFile,
  instructionPaths,
  needsRebuild,
  refreshSplitInstructions,
} from '../runtime/instruction-builder.js';
import {
  assembleInstruction,
  needsRebuild as leafNeedsRebuild,
} from '../runtime/assembler.mjs';
import { migrateClaudeMdToZylosMd, runMigrations } from '../migrate.js';

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
      fs.rmSync(root, { recursive: true, force: true });
    });
  }

  it('runs from the materialized leaf after package code is unavailable', () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('codex', { zylosDir: root });
    fs.appendFileSync(paths.userPath, '\nMATERIALIZED_ONLY_SENTINEL\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(paths.userPath, future, future);
    execFileSync(process.execPath, [
      paths.assemblerPath,
      '--marker', paths.markerPath,
      '--system', paths.systemPath,
      '--user', paths.userPath,
      '--output', paths.outputPath,
    ], { cwd: root });
    assert.match(fs.readFileSync(paths.outputPath, 'utf8'), /MATERIALIZED_ONLY_SENTINEL/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects an active launch boundary until the generation is prepared', () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const userPath = instructionPaths('codex', { zylosDir: root }).userPath;
    fs.appendFileSync(userPath, '\nchanged\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(userPath, future, future);
    assert.throws(() => assertInstructionReady('codex', { zylosDir: root }), /not prepared before launch/);
    const current = new Date();
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

  it('treats cleanup failure as committed and retry converges without residue', () => {
    const root = fixture();
    activateFreshSplitInstructions({
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) { if (point === 'cleanup') throw new Error('cleanup fault'); },
    });
    assert.equal(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath), true);
    refreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restores the complete active generation when a refresh rename fails', () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const watched = [
      instructionPaths('claude', { zylosDir: root }).markerPath,
      instructionPaths('claude', { zylosDir: root }).systemPath,
      instructionPaths('codex', { zylosDir: root }).systemPath,
      instructionPaths('claude', { zylosDir: root }).outputPath,
      instructionPaths('codex', { zylosDir: root }).outputPath,
    ];
    const before = watched.map(filePath => fs.readFileSync(filePath));
    assert.throws(() => refreshSplitInstructions({
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) { if (point === 'rename:codex-output') throw new Error('active rename fault'); },
    }), /active rename fault/);
    watched.forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), before[index]));
    assert.deepEqual(leftovers(root), []);
    refreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('pre-v0.4 migration', () => {
  it('uses an explicit root, preserves CLAUDE.md, and does not activate split mode', () => {
    const root = fixture();
    const legacy = Buffer.from('# Legacy\ncustom\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), legacy);
    const result = runMigrations({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.ok(result.migrated.includes('v0.4.0/claude-md-to-zylos-md'));
    assert.deepEqual(fs.readFileSync(path.join(root, 'CLAUDE.md')), legacy);
    assert.ok(fs.readFileSync(path.join(root, 'ZYLOS.md'), 'utf8').endsWith(legacy.toString()));
    assert.equal(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves the legacy file unchanged when migration staging fails', () => {
    const root = fixture();
    const legacy = Buffer.from('legacy bytes\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), legacy);
    assert.throws(() => migrateClaudeMdToZylosMd({
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) { if (point === 'rename:user') throw new Error('rename fault'); },
    }), /rename fault/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'CLAUDE.md')), legacy);
    assert.equal(fs.existsSync(path.join(root, 'ZYLOS.md')), false);
    assert.equal(migrateClaudeMdToZylosMd({ zylosDir: root, templatesDir: TEMPLATES_DIR }), true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
