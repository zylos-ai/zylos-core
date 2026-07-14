import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { migrateInstructionsCommand } from '../../commands/migrate-instructions.js';
import {
  classifyInstructionBaseline,
  convergeAssemblerTopology,
  executeMigrationApply,
  inspectAssemblerTopology,
  loadInstructionCatalog,
  migrationPromptPath,
  stripManagedBlocks,
  verifyInstructionConservation,
  writeMigrationPrompt,
} from '../instruction-migration.js';
import {
  activateFreshSplitInstructions,
  instructionFormatVersionPath,
  instructionPaths,
  readInstructionFormatVersion,
  writeInstructionFormatVersion,
} from '../runtime/instruction-builder.js';
import { canonicalAssemblerEntry } from '../sync-settings-hooks.js';
import { exportInstructionBaselines } from '../../../scripts/export-instruction-baselines.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-migrate-test-'));
}

function capture() {
  const stdout = [];
  const stderr = [];
  let exitCode = 0;
  return {
    stdout,
    stderr,
    get exitCode() { return exitCode; },
    deps: {
      log: message => stdout.push(String(message)),
      error: message => stderr.push(String(message)),
      setExitCode: code => { exitCode = code; },
    },
  };
}

function treeSnapshot(root) {
  const result = {};
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      const relative = path.relative(root, filePath);
      if (entry.isDirectory()) walk(filePath);
      else result[relative] = fs.readFileSync(filePath).toString('base64');
    }
  }
  walk(root);
  return result;
}

function writeKnownBaseline(root) {
  const entry = loadInstructionCatalog().find(item => item.rawContent.includes('#')) ?? loadInstructionCatalog()[0];
  fs.writeFileSync(path.join(root, 'ZYLOS.md'), entry.rawContent);
  return entry;
}

describe('instruction migration classification and conservation', () => {
  it('strips only complete managed blocks and matches their historical baseline', () => {
    const catalog = loadInstructionCatalog();
    const entry = catalog.find(item => item.rawContent.includes('zylos-managed:onboarding:begin'));
    assert.ok(entry);
    const analysis = classifyInstructionBaseline({ original: entry.rawContent, catalog });
    assert.equal(analysis.classification, 'A');
    assert.equal(analysis.matched.sha256, entry.sha256);
    const truncated = entry.rawContent.replace('<!-- zylos-managed:onboarding:end -->', '');
    assert.notEqual(stripManagedBlocks(truncated).content, entry.content);
  });

  it('requires an ordered occurrence-preserving interleave', () => {
    const catalog = [{ sha256: 'x', content: 'system\ndup\n', sourceCommit: 'c' }];
    assert.equal(verifyInstructionConservation({
      strippedContent: 'system\ndup\nuser\ndup\n',
      userContent: 'user\ndup\n',
      catalog,
      matched: null,
    }).ok, true);
    assert.equal(verifyInstructionConservation({
      strippedContent: 'dup\nsystem\nuser\ndup\n',
      userContent: 'user\ndup\n',
      catalog,
      matched: null,
    }).ok, false);
  });

  it('allows C content to use an empty baseline only when all occurrences remain user-owned', () => {
    const catalog = [{ sha256: 'x', content: 'known system\n', sourceCommit: 'c' }];
    const original = 'unreachable system edit\nowner line\ndup\ndup\n';
    const accepted = verifyInstructionConservation({
      strippedContent: original,
      userContent: original,
      catalog,
      matched: null,
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.matched, null);
    assert.equal(accepted.attributionBaseline.kind, 'owner-attributed-empty-baseline');
    assert.ok(accepted.attribution.every(item => item.source === 'user'));
    for (const userContent of [
      'unreachable system edit\nowner line\ndup\n',
      'owner line\nunreachable system edit\ndup\ndup\n',
      'unreachable system edit\nowner line\ndup\ndup\ndup\n',
    ]) {
      assert.equal(verifyInstructionConservation({
        strippedContent: original,
        userContent,
        catalog,
        matched: null,
      }).ok, false);
    }
  });

  it('uses authoritative provenance for B and never promotes the same pure-add candidate without it', () => {
    const catalog = [{ sha256: 'seed-hash', content: 'system\n', rawContent: 'system\n', sourceCommit: 'c' }];
    const withoutLedger = classifyInstructionBaseline({ original: 'system\nuser\n', catalog });
    assert.equal(withoutLedger.classification, 'C');
    const withLedger = classifyInstructionBaseline({
      original: 'system\nuser\n',
      catalog,
      provenance: { seedSha256: 'seed-hash' },
    });
    assert.equal(withLedger.classification, 'B');
    assert.equal(withLedger.residual, 'user\n');
  });

  it('keeps nested and lookalike managed markers in the candidate', () => {
    const nested = [
      '<!-- zylos-managed:onboarding:begin -->',
      '<!-- zylos-managed:onboarding:begin -->',
      'nested',
      '<!-- zylos-managed:onboarding:end -->',
      '<!-- zylos-managed:onboarding:end -->',
      '',
    ].join('\n');
    assert.equal(stripManagedBlocks(nested).content, nested);
    const lookalike = 'Do not delete text mentioning zylos-managed:runtime-portability.\n';
    assert.equal(stripManagedBlocks(lookalike).content, lookalike);
    const migrationLookalike = [
      '<!-- MIGRATION NOTE (zylos v0.4.0): This file was created from your previous',
      '     user-edited content that only resembles the canonical notice. -->',
      '',
    ].join('\n');
    assert.equal(stripManagedBlocks(migrationLookalike).content, migrationLookalike);
    const betweenLines = [
      'before',
      '<!-- zylos-managed:onboarding:begin -->',
      'managed',
      '<!-- zylos-managed:onboarding:end -->',
      'after',
      '',
    ].join('\n');
    assert.equal(stripManagedBlocks(betweenLines).content, 'before\nafter\n');
  });
});

describe('shared migration apply engine and prompt', () => {
  function aClassInput(root) {
    const baseline = writeKnownBaseline(root);
    const original = fs.readFileSync(path.join(root, 'ZYLOS.md'), 'utf8');
    const catalog = loadInstructionCatalog();
    const analysis = classifyInstructionBaseline({ original, catalog });
    const conservation = verifyInstructionConservation({
      strippedContent: analysis.strippedContent,
      userContent: '',
      catalog,
      matched: analysis.matched,
    });
    return { baseline, original, analysis, conservation };
  }

  it('uses the conservation match, closes the prompt, writes v2 before A3 and returns structured success', () => {
    const root = fixture();
    const input = aClassInput(root);
    const promptPath = migrationPromptPath({ zylosDir: root });
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, 'stale prompt\n');
    const result = executeMigrationApply({
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      original: input.original,
      analysis: input.analysis,
      userContent: fs.readFileSync(path.join(TEMPLATES_DIR, 'ZYLOS.md'), 'utf8'),
      conservation: input.conservation,
    });
    assert.equal(result.migrated, true);
    assert.equal(result.fatal, false);
    assert.equal(result.versionWritten, true);
    assert.equal(result.a3Pending, false);
    assert.equal(fs.existsSync(promptPath), false);
    assert.equal(readInstructionFormatVersion({ zylosDir: root }).version, 2);
    const marker = JSON.parse(fs.readFileSync(instructionPaths('claude', { zylosDir: root }).markerPath));
    assert.equal(marker.migration.matchedTemplate.sha256, input.conservation.matched.sha256);
    assert.match(fs.readFileSync(path.join(result.backupPath, 'migration-report.md'), 'utf8'), new RegExp(input.conservation.matched.sha256));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps F1 fatal and F2 nonfatal while preserving F2 evidence', () => {
    for (const phase of ['backup', 'transaction']) {
      const root = fixture();
      const input = aClassInput(root);
      const result = executeMigrationApply({
        zylosDir: root,
        templatesDir: TEMPLATES_DIR,
        original: input.original,
        analysis: input.analysis,
        userContent: fs.readFileSync(path.join(TEMPLATES_DIR, 'ZYLOS.md'), 'utf8'),
        conservation: input.conservation,
        backupFaultInjector(point) { if (phase === 'backup' && point.startsWith('backup:copy:')) throw new Error('F1'); },
        faultInjector(point) { if (phase === 'transaction' && point === 'rename:codex-system') throw new Error('F2'); },
      });
      assert.equal(result.migrated, false);
      assert.equal(result.fatal, phase === 'backup');
      if (phase === 'backup') assert.equal(result.backupPath, null);
      else {
        assert.ok(result.backupPath);
        assert.match(fs.readFileSync(path.join(result.backupPath, 'migration-report.md'), 'utf8'), /Primary error: F2/);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats prompt cleanup, version write and A3 faults as post-commit pending work', () => {
    const root = fixture();
    const input = aClassInput(root);
    const promptPath = migrationPromptPath({ zylosDir: root });
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, 'stale\n');
    const warnings = [];
    const result = executeMigrationApply({
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      original: input.original,
      analysis: input.analysis,
      userContent: fs.readFileSync(path.join(TEMPLATES_DIR, 'ZYLOS.md'), 'utf8'),
      conservation: input.conservation,
      promptIo: { unlinkSync() { throw new Error('unlink fault'); } },
      versionIo: { writeFileSync() { throw new Error('version fault'); } },
      settingsIo: {
        existsSync() { return true; },
        readFileSync() { throw new Error('settings fault'); },
      },
      warn: message => warnings.push(message),
    });
    assert.equal(result.migrated, true);
    assert.equal(result.versionWritten, false);
    assert.match(result.versionWriteError.message, /version fault/);
    assert.equal(result.a3Pending, true);
    assert.equal(fs.existsSync(promptPath), true);
    assert.equal(warnings.length, 2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the C prompt atomically and leaves no partial temp on failure', () => {
    const root = fixture();
    const analysis = { classification: 'C', candidates: [], managedBlocks: [] };
    const written = writeMigrationPrompt({ zylosDir: root, analysis, originalSha256: 'abc' });
    assert.match(fs.readFileSync(written.filePath, 'utf8'), /Original ZYLOS\.md SHA-256: abc/);
    fs.unlinkSync(written.filePath);
    assert.throws(() => writeMigrationPrompt({
      zylosDir: root,
      analysis,
      io: { renameSync() { throw new Error('prompt rename fault'); } },
    }), /prompt rename fault/);
    assert.equal(fs.existsSync(written.filePath), false);
    assert.deepEqual(fs.readdirSync(path.dirname(written.filePath)), []);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('instruction baseline exporter', () => {
  it('is idempotent, sees both paths and branch-only history, and preserves prior entries', () => {
    const root = fixture();
    const runGit = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    runGit('init');
    runGit('config', 'user.email', 'test@example.com');
    runGit('config', 'user.name', 'Test');
    fs.mkdirSync(path.join(root, 'templates'));
    fs.writeFileSync(path.join(root, 'templates', 'ZYLOS.md'), 'shared\n');
    fs.writeFileSync(path.join(root, 'templates', 'CLAUDE.md'), 'shared\n');
    runGit('add', '.');
    runGit('commit', '-m', 'initial');
    const initial = runGit('rev-parse', 'HEAD').toString().trim();
    fs.writeFileSync(path.join(root, 'templates', 'CLAUDE.md'), 'claude-v2\n');
    runGit('commit', '-am', 'main update');
    runGit('tag', 'v-test');
    const mainBranch = runGit('branch', '--show-current').toString().trim();
    runGit('switch', '-c', 'branch-only', initial);
    fs.writeFileSync(path.join(root, 'templates', 'ZYLOS.md'), 'branch-only\n');
    runGit('commit', '-am', 'branch-only baseline');
    runGit('switch', mainBranch);
    const outputPath = path.join(root, 'out', 'manifest.json');
    const first = exportInstructionBaselines({ repoRoot: root, outputPath });
    assert.equal(first.entries.length, 3);
    assert.ok(first.entries.some(entry => Buffer.from(entry.contentBase64, 'base64').toString() === 'branch-only\n'));
    const shared = first.entries.find(entry => Buffer.from(entry.contentBase64, 'base64').toString() === 'shared\n');
    assert.deepEqual(shared.paths, ['templates/CLAUDE.md', 'templates/ZYLOS.md']);
    const bytes = fs.readFileSync(outputPath);
    exportInstructionBaselines({ repoRoot: root, outputPath });
    assert.deepEqual(fs.readFileSync(outputPath), bytes);
    runGit('branch', '-D', 'branch-only');
    const afterDelete = exportInstructionBaselines({ repoRoot: root, outputPath });
    assert.equal(afterDelete.entries.length, 3);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('assembler A3 topology', () => {
  it('converges missing/drift while preserving duplicate foreign-only groups byte-for-byte', () => {
    const root = fixture();
    const canonical = canonicalAssemblerEntry({ zylosDir: root });
    const foreignGroups = [
      { hooks: [{ type: 'command', command: 'node /foreign-a.js', async: true }] },
      { matcher: '', hooks: [{ type: 'command', command: 'node /foreign-b.js' }] },
      { matcher: 'resume', hooks: [{ type: 'command', command: 'node /foreign-c.js' }] },
      { matcher: 'resume', hooks: [{ command: 42, keep: true }] },
    ];
    const settings = {
      model: 'keep-me',
      hooks: {
        SessionStart: [
          ...structuredClone(foreignGroups),
          { matcher: 'clear', hooks: [{ type: 'command', command: canonical.command, timeout: 1 }, { type: 'command', command: 'node /user.js' }] },
          { matcher: 'compact', hooks: [{ type: 'command', command: 'node /before.js' }, { ...canonical }] },
        ],
      },
    };
    const result = convergeAssemblerTopology(settings, { zylosDir: root });
    assert.deepEqual(result.anomalies, []);
    assert.equal(result.changed, true);
    assert.equal(settings.model, 'keep-me');
    assert.deepEqual(settings.hooks.SessionStart.slice(0, 4), foreignGroups);
    for (const matcher of ['startup', 'clear', 'compact']) {
      const group = settings.hooks.SessionStart.find(item => item.matcher === matcher);
      assert.deepEqual(group.hooks[0], canonical);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses schema, manual, duplicate and misplaced anomalies before mutation', () => {
    const root = fixture();
    const canonical = canonicalAssemblerEntry({ zylosDir: root });
    const cases = [
      { hooks: 'legacy' },
      { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ ...canonical, async: true }] }] } },
      { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ ...canonical }, { ...canonical }] }] } },
      { hooks: { SessionStart: [{ matcher: '', hooks: [{ ...canonical }] }] } },
      { hooks: { SessionStart: [{ matcher: 'startup', hooks: [] }, { matcher: 'startup', hooks: [] }] } },
    ];
    for (const settings of cases) {
      const before = structuredClone(settings);
      assert.ok(inspectAssemblerTopology(settings, { zylosDir: root }).anomalies.length > 0);
      assert.deepEqual(settings, before);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('treats absent hooks arrays as missing and exact objects independent of key insertion order', () => {
    const root = fixture();
    const canonical = canonicalAssemblerEntry({ zylosDir: root });
    const reordered = { timeout: canonical.timeout, command: canonical.command, type: canonical.type };
    const settings = { hooks: { SessionStart: [
      { matcher: 'startup' },
      { matcher: 'clear', hooks: [reordered] },
      { matcher: 'compact', hooks: [{ ...canonical }] },
    ] } };
    const inspected = inspectAssemblerTopology(settings, { zylosDir: root });
    assert.deepEqual(inspected.anomalies, []);
    assert.equal(inspected.states.startup, 'missing');
    assert.equal(inspected.states.clear, 'canonical');
    assert.doesNotThrow(() => convergeAssemblerTopology(settings, { zylosDir: root }));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('classifies projection-only drift separately from projection-external manual edits', () => {
    const root = fixture();
    const canonical = canonicalAssemblerEntry({ zylosDir: root });
    const cases = [
      [{ ...canonical }, 'canonical'],
      [{ ...canonical, command: `${canonical.command} ` }, 'drift'],
      [{ ...canonical, timeout: 1 }, 'drift'],
      [{ ...canonical, command: `${canonical.command} `, timeout: 1 }, 'drift'],
    ];
    for (const [entry, expected] of cases) {
      const result = inspectAssemblerTopology({ hooks: { SessionStart: [
        { matcher: 'startup', hooks: [entry] },
      ] } }, { zylosDir: root });
      assert.equal(result.states.startup, expected);
      assert.equal(result.anomalies.length, 0);
    }
    for (const entry of [
      { ...canonical, async: true },
      { command: canonical.command, timeout: canonical.timeout },
      { ...canonical, type: 'prompt' },
      { ...canonical, timeout: 1, async: true },
    ]) {
      const result = inspectAssemblerTopology({ hooks: { SessionStart: [
        { matcher: 'startup', hooks: [entry] },
      ] } }, { zylosDir: root });
      assert.equal(result.anomalies[0].type, 'same-key-manual');
      assert.equal(result.states.startup, undefined);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports precise schema paths and catches assembler keys in every noncanonical matcher', () => {
    const root = fixture();
    const schemaCases = [
      [null, '$'],
      [[], '$'],
      [{ hooks: 'legacy' }, '$.hooks'],
      [{ hooks: [] }, '$.hooks'],
      [{ hooks: { SessionStart: 'legacy' } }, '$.hooks.SessionStart'],
      [{ hooks: { SessionStart: [null] } }, '$.hooks.SessionStart[0]'],
      [{ hooks: { SessionStart: [{ matcher: 1 }] } }, '$.hooks.SessionStart[0].matcher'],
      [{ hooks: { SessionStart: [{ hooks: {} }] } }, '$.hooks.SessionStart[0].hooks'],
      [{ hooks: { SessionStart: [{ hooks: [null] }] } }, '$.hooks.SessionStart[0].hooks[0]'],
    ];
    for (const [settings, expectedPath] of schemaCases) {
      const result = inspectAssemblerTopology(settings, { zylosDir: root });
      assert.equal(result.anomalies[0].type, 'schema-malformed');
      assert.equal(result.anomalies[0].path, expectedPath);
    }
    const canonical = canonicalAssemblerEntry({ zylosDir: root });
    for (const group of [
      { hooks: [{ ...canonical }] },
      { matcher: '', hooks: [{ ...canonical }] },
      { matcher: 'resume', hooks: [{ ...canonical, type: 'prompt' }] },
    ]) {
      const result = inspectAssemblerTopology({ hooks: { SessionStart: [group] } }, { zylosDir: root });
      assert.equal(result.anomalies.length, 1);
      assert.equal(result.anomalies[0].type, 'misplaced');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('migrate-instructions command', () => {
  it('backfills active v2 metadata and cleans stale prompts only on --apply', async () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    const versionPath = instructionFormatVersionPath({ zylosDir: root });
    const promptPath = migrationPromptPath({ zylosDir: root });
    fs.unlinkSync(versionPath);
    fs.writeFileSync(promptPath, 'stale\n');

    const dry = capture();
    assert.equal((await migrateInstructionsCommand([], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...dry.deps,
    })).exitCode, 0);
    assert.equal(fs.existsSync(versionPath), false);
    assert.equal(fs.existsSync(promptPath), true);

    const apply = capture();
    const applied = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...apply.deps,
    });
    assert.equal(applied.exitCode, 0);
    assert.equal(applied.versionBackfilled, true);
    assert.equal(readInstructionFormatVersion({ zylosDir: root }).version, 2);
    assert.equal(fs.existsSync(promptPath), false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves an active future-format tree byte-identical before residue recovery or cleanup', async () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    writeInstructionFormatVersion({ zylosDir: root, version: 3 });
    fs.writeFileSync(migrationPromptPath({ zylosDir: root }), 'future prompt bytes\n');
    fs.writeFileSync(path.join(root, 'future.split-txn.residue'), 'future residue bytes\n');
    const before = treeSnapshot(root);
    const output = capture();

    const result = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...output.deps,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.futureFormat, true);
    assert.equal(result.version, 3);
    assert.deepEqual(treeSnapshot(root), before);
    assert.ok(output.stdout.some(line => line.includes('Future instruction format version 3')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves an inactive A-class future-format tree byte-identical before migration apply', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    writeInstructionFormatVersion({ zylosDir: root, version: 3 });
    const before = treeSnapshot(root);
    const output = capture();

    const result = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...output.deps,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.futureFormat, true);
    assert.equal(result.version, 3);
    assert.deepEqual(treeSnapshot(root), before);
    assert.equal(readInstructionFormatVersion({ zylosDir: root }).version, 3);
    assert.ok(output.stdout.some(line => line.includes('Future instruction format version 3')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('continues A3 when active version backfill and prompt cleanup fail', async () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    fs.unlinkSync(instructionFormatVersionPath({ zylosDir: root }));
    fs.writeFileSync(migrationPromptPath({ zylosDir: root }), 'stale\n');
    const output = capture();
    const result = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      versionIo: { writeFileSync() { throw new Error('backfill fault'); } },
      promptIo: { unlinkSync() { throw new Error('cleanup fault'); } },
      ...output.deps,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.versionWriteError.message, /backfill fault/);
    assert.equal(result.a3.ok, true);
    assert.equal(fs.existsSync(migrationPromptPath({ zylosDir: root })), true);
    assert.ok(output.stderr.some(line => line.includes('backfill')));
    assert.ok(output.stderr.some(line => line.includes('pending migration prompt')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps C-class dry-run byte-identical and returns a reportable success', async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'ZYLOS.md'), 'unknown baseline\ncustom\n');
    const before = treeSnapshot(root);
    const output = capture();
    const result = await migrateInstructionsCommand([], { zylosDir: root, templatesDir: TEMPLATES_DIR, ...output.deps });
    assert.equal(result.exitCode, 0);
    assert.equal(result.analysis.classification, 'C');
    assert.deepEqual(treeSnapshot(root), before);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('migrates a known A baseline, writes durable backup and converges A3 in one command', async () => {
    const root = fixture();
    const baseline = writeKnownBaseline(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const foreign = { hooks: [{ type: 'command', command: 'node /foreign.js', async: true }] };
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [foreign] } }, null, 2));
    const output = capture();
    const result = await migrateInstructionsCommand(['--apply'], { zylosDir: root, templatesDir: TEMPLATES_DIR, ...output.deps });
    assert.equal(result.exitCode, 0);
    const marker = JSON.parse(fs.readFileSync(instructionPaths('claude', { zylosDir: root }).markerPath, 'utf8'));
    assert.equal(marker.migration.matchedTemplate.sha256, baseline.sha256);
    assert.equal(marker.migration.backupPath, result.backupPath);
    assert.ok(fs.existsSync(path.join(result.backupPath, 'ZYLOS.md')));
    assert.ok(fs.existsSync(path.join(result.backupPath, 'migration-report.md')));
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.hooks.SessionStart[0], foreign);
    assert.equal(settings.hooks.SessionStart.filter(group => ['startup', 'clear', 'compact'].includes(group.matcher)).length, 3);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns partial success when A3 refuses after the instruction commit', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [
      { matcher: 'startup', hooks: [] },
      { matcher: 'startup', hooks: [] },
    ] } }, null, 2));
    const settingsBefore = fs.readFileSync(path.join(root, '.claude', 'settings.json'));
    const output = capture();
    const result = await migrateInstructionsCommand(['--apply'], { zylosDir: root, templatesDir: TEMPLATES_DIR, ...output.deps });
    assert.equal(result.exitCode, 2);
    assert.ok(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath));
    assert.deepEqual(fs.readFileSync(path.join(root, '.claude', 'settings.json')), settingsBefore);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not mask the primary F2 fault when failure-report enrichment also fails', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    const output = capture();
    const result = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      ...output.deps,
      faultInjector(point) { if (point === 'rename:codex-system') throw new Error('primary transaction fault'); },
      reportIo: { writeFileSync() { throw new Error('secondary report fault'); } },
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.error.message, /primary transaction fault/);
    assert.match(result.reportError.message, /secondary report fault/);
    assert.ok(fs.existsSync(path.join(result.backupPath, 'ZYLOS.md')));
    assert.match(fs.readFileSync(path.join(result.backupPath, 'migration-report.md'), 'utf8'), /Instruction migration report/);
    const fallback = fs.readFileSync(path.join(result.backupPath, 'migration-failure-fallback.md'), 'utf8');
    assert.match(fallback, /Primary error: primary transaction fault/);
    assert.match(fallback, /Recovery residue present:/);
    assert.equal(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves an enriched F2 report and durable backup across recovery retry', async () => {
    const root = fixture();
    const original = writeKnownBaseline(root);
    const first = capture();
    const failed = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      ...first.deps,
      faultInjector(point) { if (point === 'rename:codex-system') throw new Error('injected F2'); },
    });
    assert.equal(failed.exitCode, 1);
    const report = fs.readFileSync(path.join(failed.backupPath, 'migration-report.md'), 'utf8');
    assert.match(report, /Primary error: injected F2/);
    assert.match(report, /Recovery residue present: (yes|no)/);
    assert.equal(fs.readFileSync(path.join(failed.backupPath, 'ZYLOS.md'), 'utf8'), original.rawContent);
    const second = capture();
    const retried = await migrateInstructionsCommand(['--apply'], { zylosDir: root, templatesDir: TEMPLATES_DIR, ...second.deps });
    assert.equal(retried.exitCode, 0);
    assert.ok(fs.existsSync(failed.backupPath));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('cleans F1 partial backup and leaves live files byte-identical', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    const before = treeSnapshot(root);
    const output = capture();
    const result = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      ...output.deps,
      backupFaultInjector(point) { if (point === 'backup:verify:ZYLOS.md') throw new Error('injected F1'); },
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(treeSnapshot(root), before);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports committed cleanup residue in dry-run and recovers it before active apply', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    const first = capture();
    const migrated = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      ...first.deps,
      faultInjector(point) { if (point === 'cleanup:backup:user') throw new Error('keep committed backup'); },
    });
    assert.equal(migrated.exitCode, 0);
    assert.equal(migrated.cleanupResidue, true);
    assert.ok(first.stdout.some(line => line.includes('cleanup residue')));
    const beforeDryRun = treeSnapshot(root);
    const dry = capture();
    assert.equal((await migrateInstructionsCommand([], { zylosDir: root, templatesDir: TEMPLATES_DIR, ...dry.deps })).exitCode, 0);
    assert.deepEqual(treeSnapshot(root), beforeDryRun);
    assert.ok(dry.stdout.some(line => line.includes('recovery residue')));
    const apply = capture();
    assert.equal((await migrateInstructionsCommand(['--apply'], { zylosDir: root, templatesDir: TEMPLATES_DIR, ...apply.deps })).exitCode, 0);
    assert.ok(apply.stdout.some(line => line.includes('Recovered')));
    assert.equal(Object.keys(treeSnapshot(root)).some(name => name.includes('.split-txn.')), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('combines cleanup residue with A3 refusal as partial success', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const canonical = canonicalAssemblerEntry({ zylosDir: root });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [
      { matcher: 'clear', hooks: [{ ...canonical }, { ...canonical }] },
    ] } }, null, 2));
    const settingsBefore = fs.readFileSync(path.join(root, '.claude', 'settings.json'));
    const output = capture();
    const result = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      ...output.deps,
      faultInjector(point) { if (point === 'cleanup:backup:user') throw new Error('keep committed backup'); },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.cleanupResidue, true);
    assert.deepEqual(fs.readFileSync(path.join(root, '.claude', 'settings.json')), settingsBefore);
    assert.ok(output.stdout.some(line => line.includes('cleanup residue')));
    assert.ok(output.stderr.some(line => line.includes('duplicate-entry')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps active dry-run anomaly reporting on stdout with zero writes', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    const migrated = capture();
    assert.equal((await migrateInstructionsCommand(['--apply'], { zylosDir: root, templatesDir: TEMPLATES_DIR, ...migrated.deps })).exitCode, 0);
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, '{"hooks":"legacy"}\n');
    const before = treeSnapshot(root);
    const output = capture();
    const result = await migrateInstructionsCommand([], { zylosDir: root, templatesDir: TEMPLATES_DIR, ...output.deps });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(treeSnapshot(root), before);
    assert.deepEqual(output.stderr, []);
    assert.ok(output.stdout.some(line => line.includes('schema-malformed')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps settings old bytes on handled atomic-write failure and converges on retry', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    const migrated = capture();
    assert.equal((await migrateInstructionsCommand(['--apply'], { zylosDir: root, templatesDir: TEMPLATES_DIR, ...migrated.deps })).exitCode, 0);
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.hooks.SessionStart.find(group => group.matcher === 'clear').hooks[0].timeout = 1;
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const before = fs.readFileSync(settingsPath);
    const failed = capture();
    const result = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      ...failed.deps,
      settingsIo: { writeFileSync() { throw new Error('settings write denied'); } },
    });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(fs.readFileSync(settingsPath), before);
    assert.ok(failed.stderr.some(line => line.includes('settings write denied')));
    const retry = capture();
    assert.equal((await migrateInstructionsCommand(['--apply'], { zylosDir: root, templatesDir: TEMPLATES_DIR, ...retry.deps })).exitCode, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves a 0600 live instruction file through the migration transaction', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    const userPath = path.join(root, 'ZYLOS.md');
    fs.chmodSync(userPath, 0o600);
    const output = capture();
    assert.equal((await migrateInstructionsCommand(['--apply'], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...output.deps,
    })).exitCode, 0);
    assert.equal(fs.statSync(userPath).mode & 0o777, 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves a 0600 settings file through A3 atomic convergence', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    const migrated = capture();
    assert.equal((await migrateInstructionsCommand(['--apply'], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...migrated.deps,
    })).exitCode, 0);
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.hooks.SessionStart.find(group => group.matcher === 'clear').hooks[0].timeout = 1;
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    fs.chmodSync(settingsPath, 0o600);
    const converged = capture();
    assert.equal((await migrateInstructionsCommand(['--apply'], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...converged.deps,
    })).exitCode, 0);
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('dispatches the real CLI and rejects unknown flags', () => {
    const root = fixture();
    writeKnownBaseline(root);
    const cli = path.join(REPO_ROOT, 'cli', 'zylos.js');
    const unknown = spawnSync(process.execPath, [cli, 'migrate-instructions', '--wat'], {
      env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8',
    });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown flag: --wat/);
    const dry = spawnSync(process.execPath, [cli, 'migrate-instructions'], {
      env: { ...process.env, ZYLOS_DIR: root }, encoding: 'utf8',
    });
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /Classification: A/);
    assert.equal(dry.stderr, '');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs the authoritative-provenance B path end to end', async () => {
    const root = fixture();
    const baseline = loadInstructionCatalog()[0];
    fs.writeFileSync(path.join(root, 'ZYLOS.md'), `${baseline.content}user-only\n`);
    const output = capture();
    const result = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      provenance: { seedSha256: baseline.sha256 },
      ...output.deps,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(root, 'ZYLOS.md'), 'utf8'), 'user-only\n');
    const marker = JSON.parse(fs.readFileSync(instructionPaths('claude', { zylosDir: root }).markerPath, 'utf8'));
    assert.equal(marker.migration.classification, 'B');
    const report = fs.readFileSync(path.join(result.backupPath, 'migration-report.md'), 'utf8');
    assert.match(report, /Occurrence edit script/);
    assert.match(report, /original\[0\] -> baseline\[0\]/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('accepts C with complete user occurrences and refuses omitted or reordered duplicates', async () => {
    const baseline = loadInstructionCatalog().find(entry => entry.content.endsWith('\n'));
    assert.ok(baseline);
    const root = fixture();
    const user = 'custom\ndup\n';
    fs.writeFileSync(path.join(root, 'ZYLOS.md'), `${baseline.content}${user}`);
    const output = capture();
    const userPath = path.join(root, 'user.md');
    fs.writeFileSync(userPath, user);
    const result = await migrateInstructionsCommand(['--apply', '--user-content', userPath], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...output.deps,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(root, 'ZYLOS.md'), 'utf8'), user);
    fs.rmSync(root, { recursive: true, force: true });

    for (const badUser of ['custom\n', 'dup\ncustom\n']) {
      const badRoot = fixture();
      fs.writeFileSync(path.join(badRoot, 'ZYLOS.md'), `${baseline.content}${user}`);
      const badPath = path.join(badRoot, 'user.md');
      fs.writeFileSync(badPath, badUser);
      const before = treeSnapshot(badRoot);
      const rejected = capture();
      const badResult = await migrateInstructionsCommand(['--apply', '--user-content', badPath], {
        zylosDir: badRoot, templatesDir: TEMPLATES_DIR, ...rejected.deps,
      });
      assert.equal(badResult.exitCode, 1);
      assert.deepEqual(treeSnapshot(badRoot), before);
      fs.rmSync(badRoot, { recursive: true, force: true });
    }
  });

  it('migrates an unreachable mixed-edit C baseline only when the owner keeps every occurrence', async () => {
    const original = 'unreachable legacy system line\nowner custom line\ndup\ndup\n';
    const root = fixture();
    fs.writeFileSync(path.join(root, 'ZYLOS.md'), original);
    const userPath = path.join(root, 'user.md');
    fs.writeFileSync(userPath, original);
    const output = capture();
    const result = await migrateInstructionsCommand(['--apply', '--user-content', userPath], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...output.deps,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(root, 'ZYLOS.md'), 'utf8'), original);
    const marker = JSON.parse(fs.readFileSync(instructionPaths('claude', { zylosDir: root }).markerPath, 'utf8'));
    assert.equal(marker.migration.matchedTemplate, null);
    assert.equal(marker.migration.attributionBaseline.kind, 'owner-attributed-empty-baseline');
    fs.rmSync(root, { recursive: true, force: true });

    for (const badUser of [
      'unreachable legacy system line\nowner custom line\ndup\n',
      'owner custom line\nunreachable legacy system line\ndup\ndup\n',
    ]) {
      const badRoot = fixture();
      fs.writeFileSync(path.join(badRoot, 'ZYLOS.md'), original);
      const badPath = path.join(badRoot, 'user.md');
      fs.writeFileSync(badPath, badUser);
      const before = treeSnapshot(badRoot);
      const rejected = capture();
      assert.equal((await migrateInstructionsCommand(['--apply', '--user-content', badPath], {
        zylosDir: badRoot, templatesDir: TEMPLATES_DIR, ...rejected.deps,
      })).exitCode, 1);
      assert.deepEqual(treeSnapshot(badRoot), before);
      fs.rmSync(badRoot, { recursive: true, force: true });
    }
  });

  it('covers every migrated transaction entry stage and rename rollback with successful retry', async () => {
    const points = [
      'stage:user', 'stage:claude-system', 'stage:codex-system', 'stage:onboarding',
      'stage:assembler', 'stage:claude-output', 'stage:codex-output', 'stage:marker',
      'rename:user', 'rename:claude-system', 'rename:codex-system', 'rename:onboarding',
      'rename:assembler', 'rename:claude-output', 'rename:codex-output', 'rename:marker',
    ];
    for (const target of points) {
      const root = fixture();
      const baseline = writeKnownBaseline(root);
      const failedOutput = capture();
      const failed = await migrateInstructionsCommand(['--apply'], {
        zylosDir: root,
        templatesDir: TEMPLATES_DIR,
        ...failedOutput.deps,
        faultInjector(point) { if (point === target) throw new Error(`fault ${target}`); },
      });
      assert.equal(failed.exitCode, 1, target);
      assert.equal(fs.existsSync(instructionPaths('claude', { zylosDir: root }).markerPath), false, target);
      assert.equal(fs.readFileSync(path.join(root, 'ZYLOS.md'), 'utf8'), baseline.rawContent, target);
      const retryOutput = capture();
      const retried = await migrateInstructionsCommand(['--apply'], {
        zylosDir: root, templatesDir: TEMPLATES_DIR, ...retryOutput.deps,
      });
      assert.equal(retried.exitCode, 0, target);
      assert.equal(Object.keys(treeSnapshot(root)).some(name => name.includes('.split-txn.')), false, target);
      assert.ok(fs.existsSync(failed.backupPath), target);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('combines cleanup residue with handled A3 I/O error', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    const output = capture();
    const result = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      ...output.deps,
      faultInjector(point) { if (point === 'cleanup:backup:user') throw new Error('keep committed backup'); },
      settingsIo: { writeFileSync() { throw new Error('A3 write failure'); } },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.cleanupResidue, true);
    assert.ok(output.stdout.some(line => line.includes('cleanup residue')));
    assert.ok(output.stderr.some(line => line.includes('A3 write failure')));
    const retry = capture();
    assert.equal((await migrateInstructionsCommand(['--apply'], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...retry.deps,
    })).exitCode, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('maps active settings read failures to A4 partial success', async () => {
    const root = fixture();
    writeKnownBaseline(root);
    const initial = capture();
    assert.equal((await migrateInstructionsCommand(['--apply'], {
      zylosDir: root, templatesDir: TEMPLATES_DIR, ...initial.deps,
    })).exitCode, 0);
    const settingsBefore = fs.readFileSync(path.join(root, '.claude', 'settings.json'));
    const output = capture();
    const result = await migrateInstructionsCommand(['--apply'], {
      zylosDir: root,
      templatesDir: TEMPLATES_DIR,
      ...output.deps,
      settingsIo: {
        existsSync: () => true,
        readFileSync() { throw new Error('settings read failure'); },
      },
    });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(fs.readFileSync(path.join(root, '.claude', 'settings.json')), settingsBefore);
    assert.ok(output.stderr.some(line => line.includes('settings read failure')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps settings old-or-new across SIGKILL on both sides of atomic rename', async () => {
    const childPath = path.join(REPO_ROOT, 'cli', 'lib', '__tests__', 'fixtures', 'settings-atomic-crash-child.js');
    for (const mode of ['before', 'after']) {
      const root = fixture();
      writeKnownBaseline(root);
      const initial = capture();
      assert.equal((await migrateInstructionsCommand(['--apply'], {
        zylosDir: root, templatesDir: TEMPLATES_DIR, ...initial.deps,
      })).exitCode, 0);
      const settingsPath = path.join(root, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      settings.hooks.SessionStart.find(group => group.matcher === 'clear').hooks[0].timeout = 1;
      const oldBytes = JSON.stringify(settings, null, 2) + '\n';
      fs.writeFileSync(settingsPath, oldBytes);

      const child = fork(childPath, [root, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('message', message => {
          if (message.boundary !== mode) return;
          child.kill('SIGKILL');
        });
        child.once('exit', resolve);
      });
      const observed = fs.readFileSync(settingsPath, 'utf8');
      if (mode === 'before') assert.equal(observed, oldBytes);
      else {
        const committed = JSON.parse(observed);
        assert.equal(committed.hooks.SessionStart.find(group => group.matcher === 'clear').hooks[0].timeout, 20000);
      }
      const retry = capture();
      assert.equal((await migrateInstructionsCommand(['--apply'], {
        zylosDir: root, templatesDir: TEMPLATES_DIR, ...retry.deps,
      })).exitCode, 0);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
