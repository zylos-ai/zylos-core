import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
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
} from '../instruction-migration.js';
import {
  activateFreshSplitInstructions,
  instructionPaths,
  readInstructionFormatVersion,
  writeInstructionFormatVersion,
} from '../runtime/instruction-builder.js';
import { canonicalAssemblerEntry } from '../sync-runtime-hooks.js';

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

});

describe('migrate-instructions command', () => {

  it('leaves an active future-format tree byte-identical before residue recovery or cleanup', async () => {
    const root = fixture();
    activateFreshSplitInstructions({ zylosDir: root, templatesDir: TEMPLATES_DIR });
    writeInstructionFormatVersion({ zylosDir: root, version: 3 });
    const promptPath = migrationPromptPath({ zylosDir: root });
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, 'future prompt bytes\n');
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
