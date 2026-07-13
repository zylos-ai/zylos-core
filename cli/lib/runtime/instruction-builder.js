import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ZYLOS_DIR } from '../config.js';
import {
  assembleInstruction,
  needsRebuild as leafNeedsRebuild,
  renderInstruction,
} from './assembler.mjs';

const PACKAGE_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const DEFAULT_TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');
const ASSEMBLER_SOURCE = path.join(import.meta.dirname, 'assembler.mjs');
export const SPLIT_MARKER_VERSION = 1;

function assertRuntime(runtime) {
  if (runtime !== 'claude' && runtime !== 'codex') {
    throw new TypeError(`Unsupported runtime: ${runtime}`);
  }
}

export function instructionPaths(runtime, { zylosDir = ZYLOS_DIR } = {}) {
  assertRuntime(runtime);
  const root = path.resolve(zylosDir);
  const instructionsDir = path.join(root, '.zylos', 'instructions');
  return {
    instructionsDir,
    markerPath: path.join(instructionsDir, 'meta.json'),
    assemblerPath: path.join(instructionsDir, 'assembler.mjs'),
    onboardingPath: path.join(instructionsDir, 'onboarding.md'),
    systemPath: path.join(instructionsDir, `${runtime}-system.md`),
    userPath: path.join(root, 'ZYLOS.md'),
    outputPath: path.join(root, runtime === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'),
  };
}

export function isSplitInstructionsActive({ zylosDir = ZYLOS_DIR } = {}) {
  return fs.existsSync(instructionPaths('claude', { zylosDir }).markerPath);
}

export function needsRebuild(runtime, { zylosDir = ZYLOS_DIR } = {}) {
  const paths = instructionPaths(runtime, { zylosDir });
  if (!fs.existsSync(paths.markerPath)) return false;
  return leafNeedsRebuild(paths);
}

export function buildInstructionFile(runtime, { zylosDir = ZYLOS_DIR, force = false } = {}) {
  const paths = instructionPaths(runtime, { zylosDir });
  if (!fs.existsSync(paths.markerPath)) return paths.outputPath;
  if (force || leafNeedsRebuild(paths)) assembleInstruction(paths);
  return paths.outputPath;
}

export function assertInstructionReady(runtime, { zylosDir = ZYLOS_DIR } = {}) {
  const paths = instructionPaths(runtime, { zylosDir });
  if (!fs.existsSync(paths.markerPath)) {
    if (!fs.existsSync(paths.outputPath)) {
      throw new Error(`${runtime} instruction file is missing while split instructions are pending migration: ${paths.outputPath}`);
    }
    return true;
  }
  if (!fs.existsSync(paths.outputPath) || leafNeedsRebuild(paths)) {
    throw new Error(`${runtime} instruction file was not prepared before launch: ${paths.outputPath}`);
  }
  return true;
}

export function buildAllInstructionFiles(options = {}) {
  buildInstructionFile('claude', options);
  buildInstructionFile('codex', options);
}

export function getInstructionFilePath(runtime, options = {}) {
  return instructionPaths(runtime, options).outputPath;
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { }
  }
}

export function deployInstructionAssets({
  zylosDir = ZYLOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  assemblerSource = ASSEMBLER_SOURCE,
} = {}) {
  const paths = instructionPaths('claude', { zylosDir });
  fs.mkdirSync(paths.instructionsDir, { recursive: true });
  for (const runtime of ['claude', 'codex']) {
    const source = path.join(templatesDir, `${runtime}-system.md`);
    if (!fs.existsSync(source)) throw new Error(`System instruction template not found: ${source}`);
    atomicWrite(instructionPaths(runtime, { zylosDir }).systemPath, fs.readFileSync(source));
  }
  const onboardingSource = path.join(templatesDir, 'onboarding.md');
  if (!fs.existsSync(onboardingSource)) throw new Error(`Onboarding instruction template not found: ${onboardingSource}`);
  atomicWrite(paths.onboardingPath, fs.readFileSync(onboardingSource));
  atomicWrite(paths.assemblerPath, fs.readFileSync(assemblerSource));
  return paths.instructionsDir;
}

function splitTransactionRoots(zylosDir) {
  return [path.resolve(zylosDir), instructionPaths('claude', { zylosDir }).instructionsDir];
}

function hasSplitTransactionResidue(zylosDir) {
  for (const root of splitTransactionRoots(zylosDir)) {
    try {
      if (fs.readdirSync(root).some(name => name.includes('.split-txn.'))) return true;
    } catch { }
  }
  return false;
}

function cleanupSplitTemps(zylosDir) {
  for (const root of splitTransactionRoots(zylosDir)) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.includes('.split-txn.')) continue;
      // Backups are recovery records, not disposable temporary files.
      if (name.endsWith('.bak')) continue;
      try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { }
    }
  }
}

function recoverSplitTransaction(zylosDir, faultInjector = () => {}) {
  const markerPath = instructionPaths('claude', { zylosDir }).markerPath;
  let committedTransactionId;
  try {
    committedTransactionId = JSON.parse(fs.readFileSync(markerPath, 'utf8')).transactionId;
  } catch { }

  const backups = [];
  for (const root of splitTransactionRoots(zylosDir)) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const match = name.match(/^(.*)\.split-txn\.([^.]+\.[^.]+\.[^.]+)\.bak$/);
      if (!match) continue;
      backups.push({
        backupPath: path.join(root, name),
        path: path.join(root, match[1]),
        token: match[2],
        name: match[1],
      });
    }
  }

  const errors = [];
  for (const backup of backups) {
    try {
      if (backup.token === committedTransactionId) {
        faultInjector(`recover:discard:${backup.name}`);
        fs.unlinkSync(backup.backupPath);
      } else {
        faultInjector(`recover:restore:${backup.name}`);
        fs.renameSync(backup.backupPath, backup.path);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'split instruction transaction recovery failed');
  }
  cleanupSplitTemps(zylosDir);
}

function commitEntries(entries, markerPath, markerContent, faultInjector = () => {}) {
  const token = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const staged = [];
  const backups = [];
  const applied = [];
  let markerStage;
  let committed = false;
  let rollbackFailed = false;

  try {
    for (const entry of entries) {
      faultInjector(`stage:${entry.name}`);
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      const stagePath = `${entry.path}.split-txn.${token}`;
      fs.writeFileSync(stagePath, entry.content);
      staged.push({ ...entry, stagePath });
    }
    faultInjector('stage:marker');
    markerStage = `${markerPath}.split-txn.${token}`;
    const marker = JSON.parse(markerContent);
    marker.transactionId = token;
    fs.writeFileSync(markerStage, JSON.stringify(marker, null, 2) + '\n', 'utf8');

    for (const entry of staged) {
      if (fs.existsSync(entry.path)) {
        const backupPath = `${entry.path}.split-txn.${token}.bak`;
        fs.renameSync(entry.path, backupPath);
        backups.push({ name: entry.name, path: entry.path, backupPath });
      }
      faultInjector(`rename:${entry.name}`);
      fs.renameSync(entry.stagePath, entry.path);
      applied.push(entry);
    }

    faultInjector('rename:marker');
    fs.renameSync(markerStage, markerPath);
    committed = true;
  } catch (error) {
    if (!committed) {
      const rollbackErrors = [];
      for (const entry of [...applied].reverse()) {
        try {
          faultInjector(`rollback:remove:${entry.name}`);
          fs.unlinkSync(entry.path);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const backup of [...backups].reverse()) {
        try {
          faultInjector(`rollback:restore:${backup.name}`);
          fs.renameSync(backup.backupPath, backup.path);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        rollbackFailed = true;
        throw new AggregateError(rollbackErrors, `split instruction rollback failed after: ${error.message}`, { cause: error });
      }
    }
    throw error;
  } finally {
    for (const entry of staged) {
      try { fs.unlinkSync(entry.stagePath); } catch { }
    }
    if (committed) {
      for (const backup of backups) {
        try {
          faultInjector(`cleanup:backup:${backup.name}`);
          fs.unlinkSync(backup.backupPath);
        } catch { }
      }
    }
    if (!rollbackFailed) {
      try { fs.unlinkSync(markerStage); } catch { }
    }
  }
}

export function activateFreshSplitInstructions({
  zylosDir = ZYLOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  assemblerSource = ASSEMBLER_SOURCE,
  faultInjector,
} = {}) {
  const hadTransactionResidue = hasSplitTransactionResidue(zylosDir);
  recoverSplitTransaction(zylosDir, faultInjector);
  const claude = instructionPaths('claude', { zylosDir });
  if (fs.existsSync(claude.markerPath)) {
    return refreshSplitInstructions({ zylosDir, templatesDir, assemblerSource, faultInjector });
  }

  const legacyArtifacts = [claude.userPath, claude.outputPath, instructionPaths('codex', { zylosDir }).outputPath];
  if (!hadTransactionResidue && legacyArtifacts.some(filePath => fs.existsSync(filePath))) {
    deployInstructionAssets({ zylosDir, templatesDir, assemblerSource });
    return { active: false, pendingMigration: true, markerPath: claude.markerPath };
  }

  const userContent = fs.existsSync(claude.userPath)
    ? fs.readFileSync(claude.userPath, 'utf8')
    : fs.readFileSync(path.join(templatesDir, 'ZYLOS.md'), 'utf8');
  const systems = Object.fromEntries(['claude', 'codex'].map(runtime => [
    runtime,
    fs.readFileSync(path.join(templatesDir, `${runtime}-system.md`), 'utf8'),
  ]));
  const now = new Date();
  const entries = [
    { name: 'claude-system', path: claude.systemPath, content: systems.claude },
    { name: 'codex-system', path: instructionPaths('codex', { zylosDir }).systemPath, content: systems.codex },
    { name: 'onboarding', path: claude.onboardingPath, content: fs.readFileSync(path.join(templatesDir, 'onboarding.md'), 'utf8') },
    { name: 'assembler', path: claude.assemblerPath, content: fs.readFileSync(assemblerSource) },
  ];
  if (!fs.existsSync(claude.userPath)) {
    entries.push({ name: 'seed', path: claude.userPath, content: userContent });
  }
  for (const runtime of ['claude', 'codex']) {
    const paths = instructionPaths(runtime, { zylosDir });
    const systemShadow = `${paths.systemPath}.split-render.${process.pid}`;
    const userShadow = `${paths.userPath}.split-render.${process.pid}`;
    fs.mkdirSync(path.dirname(systemShadow), { recursive: true });
    fs.writeFileSync(systemShadow, systems[runtime], 'utf8');
    fs.writeFileSync(userShadow, userContent, 'utf8');
    try {
      const content = renderInstruction({ systemPath: systemShadow, userPath: userShadow, generatedAt: now })
        .replaceAll(path.resolve(systemShadow), path.resolve(paths.systemPath))
        .replaceAll(path.resolve(userShadow), path.resolve(paths.userPath));
      entries.push({ name: `${runtime}-output`, path: paths.outputPath, content });
    } finally {
      try { fs.unlinkSync(systemShadow); } catch { }
      try { fs.unlinkSync(userShadow); } catch { }
    }
  }
  const marker = {
    schemaVersion: SPLIT_MARKER_VERSION,
    activatedAt: now.toISOString(),
    seedSha256: crypto.createHash('sha256').update(userContent).digest('hex'),
  };
  commitEntries(entries, claude.markerPath, JSON.stringify(marker, null, 2) + '\n', faultInjector);
  return { active: true, markerPath: claude.markerPath };
}

export function refreshSplitInstructions({
  zylosDir = ZYLOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  assemblerSource = ASSEMBLER_SOURCE,
  faultInjector,
} = {}) {
  recoverSplitTransaction(zylosDir, faultInjector);
  const claude = instructionPaths('claude', { zylosDir });
  if (!fs.existsSync(claude.markerPath)) {
    deployInstructionAssets({ zylosDir, templatesDir, assemblerSource });
    return { active: false, pendingMigration: true, markerPath: claude.markerPath };
  }
  const marker = JSON.parse(fs.readFileSync(claude.markerPath, 'utf8'));
  const userContent = fs.readFileSync(claude.userPath, 'utf8');
  const now = new Date();
  const entries = [];
  for (const runtime of ['claude', 'codex']) {
    const paths = instructionPaths(runtime, { zylosDir });
    const systemContent = fs.readFileSync(path.join(templatesDir, `${runtime}-system.md`), 'utf8');
    entries.push({ name: `${runtime}-system`, path: paths.systemPath, content: systemContent });
    const systemShadow = `${paths.systemPath}.split-render.${process.pid}`;
    fs.mkdirSync(path.dirname(systemShadow), { recursive: true });
    fs.writeFileSync(systemShadow, systemContent, 'utf8');
    try {
      const content = renderInstruction({ systemPath: systemShadow, userPath: paths.userPath, generatedAt: now })
        .replaceAll(path.resolve(systemShadow), path.resolve(paths.systemPath));
      entries.push({ name: `${runtime}-output`, path: paths.outputPath, content });
    } finally {
      try { fs.unlinkSync(systemShadow); } catch { }
    }
  }
  entries.push({ name: 'onboarding', path: claude.onboardingPath, content: fs.readFileSync(path.join(templatesDir, 'onboarding.md'), 'utf8') });
  entries.push({ name: 'assembler', path: claude.assemblerPath, content: fs.readFileSync(assemblerSource) });
  marker.refreshedAt = now.toISOString();
  marker.userSha256 = crypto.createHash('sha256').update(userContent).digest('hex');
  commitEntries(entries, claude.markerPath, JSON.stringify(marker, null, 2) + '\n', faultInjector);
  return { active: true, markerPath: claude.markerPath };
}
