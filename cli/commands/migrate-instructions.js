import fs from 'node:fs';
import path from 'node:path';

import { ZYLOS_DIR } from '../lib/config.js';
import {
  CURRENT_INSTRUCTION_FORMAT_VERSION,
  hasSplitTransactionResidue,
  instructionPaths,
  isSplitInstructionsActive,
  readInstructionFormatVersion,
  recoverSplitTransaction,
  writeInstructionFormatVersion,
} from '../lib/runtime/instruction-builder.js';
import {
  classifyInstructionBaseline,
  cleanupMigrationPrompt,
  executeMigrationApply,
  loadInstructionCatalog,
  reconcileAssemblerSettingsFile,
  verifyInstructionConservation,
} from '../lib/instruction-migration.js';

const PACKAGE_ROOT = path.join(import.meta.dirname, '..', '..');
const DEFAULT_TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');

function usage() {
  return `Usage: zylos migrate-instructions [--apply] [--user-content <file>]

Analyze a legacy mixed instruction file and activate split instructions safely.
The default is a zero-write dry run; --apply creates a durable backup first.`;
}

export function parseMigrateInstructionArgs(args) {
  const result = { apply: false, userContentPath: null };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') result.apply = true;
    else if (arg === '--user-content') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--user-content requires a file path');
      result.userContentPath = path.resolve(value);
    } else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return result;
}

function formatA3Problems(result) {
  return (result.anomalies ?? []).map(item => JSON.stringify(item)).join('\n');
}

export async function migrateInstructionsCommand(args, {
  zylosDir = ZYLOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  log = console.log,
  error = console.error,
  setExitCode = code => { process.exitCode = code; },
  faultInjector,
  backupFaultInjector,
  reportIo,
  settingsIo,
  versionIo,
  promptIo,
  provenance = null,
} = {}) {
  let flags;
  try {
    flags = parseMigrateInstructionArgs(args);
  } catch (parseError) {
    error(parseError.message);
    error(usage());
    setExitCode(1);
    return { exitCode: 1, fatal: true };
  }
  if (flags.help) {
    log(usage());
    return { exitCode: 0 };
  }

  const root = path.resolve(zylosDir);
  const versionState = readInstructionFormatVersion({ zylosDir: root });
  if (versionState.valid && versionState.version > CURRENT_INSTRUCTION_FORMAT_VERSION) {
    const message = `Future instruction format version ${versionState.version}; current v2 migration code does not apply.`;
    log(message);
    return { exitCode: 0, futureFormat: true, version: versionState.version, message };
  }

  const residue = hasSplitTransactionResidue(root);
  if (!flags.apply && residue) log('Transaction recovery residue detected; --apply will recover it before migration.');
  if (flags.apply) {
    try {
      recoverSplitTransaction(root, faultInjector);
      if (residue) log('Recovered split-instruction transaction residue.');
    } catch (recoveryError) {
      error(`Recovery failed: ${recoveryError.message}`);
      setExitCode(1);
      return { exitCode: 1, fatal: true, error: recoveryError };
    }
  }

  const active = isSplitInstructionsActive({ zylosDir: root });
  if (active) {
    let versionBackfilled = false;
    let versionWriteError = null;
    if (flags.apply) {
      if (!versionState.valid || versionState.version === null || versionState.version < CURRENT_INSTRUCTION_FORMAT_VERSION) {
        try {
          writeInstructionFormatVersion({ zylosDir: root, io: versionIo });
          versionBackfilled = true;
        } catch (writeError) {
          versionWriteError = writeError;
          error(`Warning: could not backfill instruction format version: ${writeError.message}`);
        }
      }
      const promptCleanup = cleanupMigrationPrompt({ zylosDir: root, io: promptIo });
      if (promptCleanup.error) error(`Warning: could not remove pending migration prompt: ${promptCleanup.error.message}`);
    }
    const a3 = reconcileAssemblerSettingsFile({ zylosDir: root, apply: flags.apply, faultInjector, io: settingsIo });
    log('Split instructions are already active.');
    if (!a3.ok) {
      if (!flags.apply) {
        log(`Dry run: A3 pending: ${a3.handledError ? a3.error.message : formatA3Problems(a3)}`);
        log(a3.handledError ? 'Resolve the I/O error, then rerun with --apply.' : 'Repair the reported settings topology, then rerun with --apply.');
        log('Dry run complete: no files were changed.');
        return { exitCode: 0, active: true, dryRun: true, a3, versionBackfilled, versionWriteError };
      }
      error(`A3 pending: ${a3.handledError ? a3.error.message : formatA3Problems(a3)}`);
      error(a3.handledError ? 'Rerun --apply after the I/O error is resolved.' : 'Repair the reported settings topology, then rerun --apply.');
      setExitCode(2);
      return { exitCode: 2, active: true, a3, versionBackfilled, versionWriteError };
    }
    if (flags.apply) log(a3.changed ? 'Assembler hooks converged.' : 'Assembler hooks already canonical.');
    else log(a3.changed ? 'Dry run: assembler hooks need convergence; --apply will repair them.' : 'Dry run: assembler hooks are canonical.');
    return { exitCode: 0, active: true, a3, versionBackfilled, versionWriteError };
  }

  const originalPath = path.join(root, 'ZYLOS.md');
  if (!fs.existsSync(originalPath)) {
    error('ZYLOS.md is missing. Run a supported upgrade or `zylos init` before migration.');
    setExitCode(1);
    return { exitCode: 1, fatal: true };
  }

  let original;
  let catalog;
  try {
    original = fs.readFileSync(originalPath, 'utf8');
    catalog = loadInstructionCatalog();
  } catch (readError) {
    error(`Instruction analysis failed: ${readError.message}`);
    setExitCode(1);
    return { exitCode: 1, fatal: true, error: readError };
  }
  const analysis = classifyInstructionBaseline({ original, catalog, provenance });
  log(`Classification: ${analysis.classification}`);
  if (analysis.matched) log(`Matched template: ${analysis.matched.sha256} (${analysis.matched.sourceCommit})`);
  else {
    log('No byte-identical reachable baseline; automatic B is unavailable without authoritative provenance.');
    for (const candidate of analysis.candidates) log(`Candidate ${candidate.sha256} score=${candidate.score.toFixed(4)} source=${candidate.sourceCommit}`);
  }

  const dryRunA3 = !flags.apply
    ? reconcileAssemblerSettingsFile({ zylosDir: root, apply: false, io: settingsIo })
    : null;
  if (dryRunA3) {
    if (!dryRunA3.ok) {
      log(`Dry run: A3 pending: ${dryRunA3.handledError ? dryRunA3.error.message : formatA3Problems(dryRunA3)}`);
      log(dryRunA3.handledError
        ? 'Resolve the I/O error, then rerun with --apply.'
        : 'Repair the reported settings topology, then rerun with --apply.');
    } else {
      log(dryRunA3.changed
        ? 'Dry run: assembler hooks need convergence; --apply will repair them.'
        : 'Dry run: assembler hooks are canonical.');
    }
  }

  if (!flags.apply && !flags.userContentPath) {
    log(analysis.classification === 'C'
      ? 'Dry run complete: no files were changed. Prepare user-only content for --user-content before applying.'
      : 'Dry run complete: no files were changed. Rerun with --apply to migrate.');
    return { exitCode: 0, dryRun: true, analysis, matched: analysis.matched };
  }

  let userContent;
  let conservedMatch = analysis.matched;
  let conservation;
  if (flags.userContentPath) {
    try { userContent = fs.readFileSync(flags.userContentPath, 'utf8'); } catch (readError) {
      error(`Cannot read --user-content: ${readError.message}`);
      setExitCode(1);
      return { exitCode: 1, fatal: true, analysis };
    }
    conservation = verifyInstructionConservation({
      strippedContent: analysis.strippedContent,
      userContent,
      catalog,
      matched: analysis.matched,
    });
    if (!conservation.ok) {
      error(`Conservation refusal: ${conservation.reason}`);
      setExitCode(1);
      return { exitCode: 1, refusal: true, analysis, conservation };
    }
    conservedMatch = conservation.matched;
  } else if (analysis.classification === 'A') {
    userContent = fs.readFileSync(path.join(templatesDir, 'ZYLOS.md'), 'utf8');
    conservation = verifyInstructionConservation({
      strippedContent: analysis.strippedContent,
      userContent: '',
      catalog,
      matched: analysis.matched,
    });
  } else if (analysis.classification === 'B') {
    userContent = analysis.residual;
    conservation = verifyInstructionConservation({
      strippedContent: analysis.strippedContent,
      userContent,
      catalog,
      matched: analysis.matched,
    });
  } else {
    error('Refusing automatic migration. Prepare user-only content and rerun with --user-content <file>.');
    setExitCode(1);
    return { exitCode: 1, refusal: true, analysis };
  }

  if (!flags.apply) {
    log('Dry run complete: no files were changed. Rerun with --apply to migrate.');
    return { exitCode: 0, dryRun: true, analysis, matched: conservedMatch };
  }

  const migration = executeMigrationApply({
    zylosDir: root,
    templatesDir,
    original,
    analysis,
    userContent,
    conservation,
    faultInjector,
    backupFaultInjector,
    reportIo,
    settingsIo,
    versionIo,
    promptIo,
    warn: error,
  });
  if (!migration.migrated) {
    if (migration.fatal) {
      error(`Backup failed before live mutation: ${migration.error.message}`);
      if (migration.error.partialBackupPath) error(`Partial backup cleanup failed; inspect: ${migration.error.partialBackupPath}`);
    } else {
      log(`Backup: ${migration.backupPath}`);
      if (migration.reportError) error(`Warning: could not enrich failure report: ${migration.reportError.message}`);
      if (migration.reportFallbackError) error(`Warning: could not write fallback failure report: ${migration.reportFallbackError.message}`);
      error(`Instruction transaction failed: ${migration.error.message}`);
      error(`Durable backup preserved: ${migration.backupPath}`);
      error('Rerun `zylos migrate-instructions --apply` to recover and converge.');
    }
    setExitCode(1);
    return { exitCode: 1, ...migration };
  }

  log(`Backup: ${migration.backupPath}`);
  log(`Instruction migration committed. Marker: ${instructionPaths('claude', { zylosDir: root }).markerPath}`);
  const cleanupResidue = migration.cleanupResidue;
  if (cleanupResidue) log('Committed transaction cleanup residue preserved; the next --apply will recover it.');
  const a3 = migration.a3;
  if (!a3.ok) {
    error(`A3 pending: ${a3.handledError ? a3.error.message : formatA3Problems(a3)}`);
    error(a3.handledError ? 'Rerun --apply after the I/O error is resolved.' : 'Repair the reported settings topology, then rerun --apply.');
    setExitCode(2);
    return { exitCode: 2, active: true, backupPath: migration.backupPath, cleanupResidue, a3, migration };
  }
  log(a3.changed ? 'Assembler hooks converged.' : 'Assembler hooks already canonical.');
  return { exitCode: 0, active: true, backupPath: migration.backupPath, cleanupResidue, a3, migration };
}
