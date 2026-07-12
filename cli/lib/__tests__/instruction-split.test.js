import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  it('pins the system templates to the reviewed legacy core-plus-addon bytes', () => {
    const managedHeader = '> **Zylos-managed system instructions.** This file is replaced during upgrades. Put all custom instructions in `~/zylos/ZYLOS.md`.\n\n';
    const expected = {
      claude: '3d40c67f22ce06101a3433a1c461aca98d1672dfe0c2f42b732fd12c2b309052',
      codex: '2eaa406ee0eeec7f70c785d496ea43fee2a375e2f949d899fa93e9ffd5e78596',
    };
    for (const runtime of ['claude', 'codex']) {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, `${runtime}-system.md`), 'utf8');
      assert.ok(content.startsWith(managedHeader));
      assert.equal(crypto.createHash('sha256').update(content.slice(managedHeader.length)).digest('hex'), expected[runtime]);
    }
  });

  it('guards the canonical assembler API against ephemeral instruction seams', () => {
    const assemblerSource = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'lib', 'runtime', 'assembler.mjs'), 'utf8');
    const builderSource = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'lib', 'runtime', 'instruction-builder.js'), 'utf8');
    assert.doesNotMatch(assemblerSource, /memorySnapshot|ephemeral/);
    assert.doesNotMatch(builderSource, /memorySnapshot|claude-addon|codex-addon|syncClaudeMd/);
  });

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

  it('keeps an unknown-baseline pure-add candidate conservative and pending for P2 classification', () => {
    const root = fixture();
    const unreachableBaseline = 'catalog candidate\nunreachable baseline X\n';
    const current = Buffer.from(`${unreachableBaseline}user Y\n`);
    fs.writeFileSync(path.join(root, 'ZYLOS.md'), current);
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), current);
    const result = refreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.equal(result.pendingMigration, true);
    assert.equal(result.active, false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'ZYLOS.md')), current);
    assert.deepEqual(fs.readFileSync(path.join(root, 'CLAUDE.md')), current);
    assert.equal(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails loudly when a pending runtime has no legacy instruction output', () => {
    const root = fixture();
    refreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.throws(
      () => assertInstructionReady('codex', { zylosDir: root }),
      /missing while split instructions are pending migration/,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

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

  for (const entryName of ['claude-system', 'codex-system', 'assembler', 'seed', 'claude-output', 'codex-output']) {
    it(`recovers a fresh activation when rollback removal fails at ${entryName}`, () => {
      const root = fixture();
      assert.throws(() => activateFreshSplitInstructions({
        zylosDir: root,
        templatesDir: TEMPLATES_DIR,
        faultInjector(point) {
          if (point === 'rename:marker') throw new Error('forward fault');
          if (point === `rollback:remove:${entryName}`) throw new Error(`remove fault:${entryName}`);
        },
      }), /rollback failed after: forward fault/);
      assert.equal(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath), false);
      assert.ok(leftovers(root).length > 0);
      const result = activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
      assert.equal(result.active, true);
      assert.deepEqual(leftovers(root), []);
      fs.rmSync(root, { recursive: true, force: true });
    });
  }

  const activeEntryNames = ['claude-system', 'claude-output', 'codex-system', 'codex-output', 'assembler'];
  for (const boundary of ['remove', 'restore']) {
    for (const entryName of activeEntryNames) {
      it(`recovers an active refresh when rollback ${boundary} fails at ${entryName}`, () => {
        const root = fixture();
        activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
        const markerPath = instructionPaths('claude', { zylosDir: root }).markerPath;
        const markerBefore = fs.readFileSync(markerPath);
        assert.throws(() => refreshSplitInstructions({
          zylosDir: root,
          templatesDir: TEMPLATES_DIR,
          faultInjector(point) {
            if (point === 'rename:marker') throw new Error('forward fault');
            if (point === `rollback:${boundary}:${entryName}`) throw new Error(`${boundary} fault:${entryName}`);
          },
        }), /rollback failed after: forward fault/);
        assert.deepEqual(fs.readFileSync(markerPath), markerBefore);
        const result = refreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
        assert.equal(result.active, true);
        assert.deepEqual(leftovers(root), []);
        fs.rmSync(root, { recursive: true, force: true });
      });
    }
  }

  it('treats cleanup failure as committed and retry converges without residue', () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    refreshSplitInstructions({
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) {
        if (point === 'cleanup:backup:claude-system') throw new Error('cleanup fault');
      },
    });
    assert.equal(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath), true);
    assert.ok(leftovers(root).some(filePath => filePath.endsWith('.bak')));
    refreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('discards a committed transaction backup without restoring stale assembler bytes', () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('claude', { zylosDir: root });
    const marker = JSON.parse(fs.readFileSync(paths.markerPath, 'utf8'));
    const current = Buffer.from('committed assembler bytes\n');
    fs.writeFileSync(paths.assemblerPath, current);
    fs.writeFileSync(`${paths.assemblerPath}.split-txn.${marker.transactionId}.bak`, 'stale assembler bytes\n');

    assert.throws(() => refreshSplitInstructions({
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) { if (point === 'stage:claude-system') throw new Error('stop after recovery'); },
    }), /stop after recovery/);

    assert.deepEqual(fs.readFileSync(paths.assemblerPath), current);
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restores an uncommitted transaction backup before starting the next refresh', () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('claude', { zylosDir: root });
    const restored = Buffer.from('restored assembler bytes\n');
    fs.writeFileSync(paths.assemblerPath, 'partial assembler bytes\n');
    fs.writeFileSync(`${paths.assemblerPath}.split-txn.111.222.deadbeef.bak`, restored);

    assert.throws(() => refreshSplitInstructions({
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) { if (point === 'stage:claude-system') throw new Error('stop after recovery'); },
    }), /stop after recovery/);

    assert.deepEqual(fs.readFileSync(paths.assemblerPath), restored);
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses fresh activation when unmarked legacy instruction artifacts exist', () => {
    const root = fixture();
    const legacyUser = Buffer.from('## Behavioral Rules\nlegacy system plus user\n');
    const legacyClaude = Buffer.from('legacy claude output\n');
    const legacyAgents = Buffer.from('legacy codex output\n');
    fs.writeFileSync(path.join(root, 'ZYLOS.md'), legacyUser);
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), legacyClaude);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), legacyAgents);
    const result = activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.equal(result.pendingMigration, true);
    assert.equal(result.active, false);
    assert.equal(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath), false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'ZYLOS.md')), legacyUser);
    assert.deepEqual(fs.readFileSync(path.join(root, 'CLAUDE.md')), legacyClaude);
    assert.deepEqual(fs.readFileSync(path.join(root, 'AGENTS.md')), legacyAgents);
    assert.ok(fs.existsSync(instructionPaths('claude', { zylosDir: root }).assemblerPath));
    fs.rmSync(root, { recursive: true, force: true });
  });

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

  it('retains a failed rollback backup and recovers it on retry', () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('claude', { zylosDir: root });
    const markerBefore = fs.readFileSync(paths.markerPath);
    let injectedRestoreFailure = false;
    assert.throws(() => refreshSplitInstructions({
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) {
        if (point === 'rename:codex-system') throw new Error('forward fault');
        if (!injectedRestoreFailure && point === 'rollback:restore:claude-system') {
          injectedRestoreFailure = true;
          throw new Error('restore EIO');
        }
      },
    }), /rollback failed after: forward fault/);
    assert.deepEqual(fs.readFileSync(paths.markerPath), markerBefore);
    assert.ok(leftovers(root).some(filePath => filePath.endsWith('.bak')));

    const result = refreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.equal(result.active, true);
    assert.ok(fs.existsSync(paths.systemPath));
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
  it('does not let a migrated legacy CLAUDE.md fall through into fresh split activation', () => {
    const root = fixture();
    const legacy = Buffer.from('## Behavioral Rules\nlegacy pre-v0.4 body\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), legacy);
    runMigrations({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const migratedUser = fs.readFileSync(path.join(root, 'ZYLOS.md'));
    const result = activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    assert.equal(result.pendingMigration, true);
    assert.equal(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath), false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'CLAUDE.md')), legacy);
    assert.deepEqual(fs.readFileSync(path.join(root, 'ZYLOS.md')), migratedUser);
    fs.rmSync(root, { recursive: true, force: true });
  });

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
