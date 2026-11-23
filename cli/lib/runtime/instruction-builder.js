// Awaits the runtime factory at module scope. Runtime implementations must not
// reach this module through static imports.
import { SUPPORTED_RUNTIMES } from './descriptors.js';
import { getRuntime } from './index.js';
import { removeOwnedTree } from '../../../skills/comm-bridge/scripts/remove-owned-tree.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ZYLOS_DIR } from '../config.js';
import {
  needsRebuild as leafNeedsRebuild,
  renderInstruction,
} from './assembler.mjs';
import { buildInstructionFor, instructionAssetPaths, instructionPathsFor } from './shared/instruction-paths.js';

export { instructionAssetPaths };

const DECLARATIONS = await Promise.all(
  SUPPORTED_RUNTIMES.map(async id => [id, (await getRuntime(id)).instructions]),
).then(entries => new Map(entries));

const PACKAGE_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const DEFAULT_TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');
const ASSEMBLER_SOURCE = path.join(import.meta.dirname, 'assembler.mjs');
export const SPLIT_MARKER_VERSION = 1;
export const CURRENT_INSTRUCTION_FORMAT_VERSION = 2;

export function instructionFormatVersionPath({ zylosDir = ZYLOS_DIR } = {}) {
  return path.join(path.resolve(zylosDir), '.zylos', 'instruction-format-version');
}

export function readInstructionFormatVersion({ zylosDir = ZYLOS_DIR, io = {} } = {}) {
  const filePath = instructionFormatVersionPath({ zylosDir });
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(filePath)) return { version: null, valid: true, exists: false, filePath };
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (!/^[1-9]\d*\n?$/.test(raw)) {
      return { version: null, valid: false, exists: true, filePath };
    }
    const version = Number(raw.trim());
    if (!Number.isSafeInteger(version)) {
      return { version: null, valid: false, exists: true, filePath };
    }
    return { version, valid: true, exists: true, filePath };
  } catch (error) {
    return { version: null, valid: false, exists: true, filePath, error };
  }
}

export function writeInstructionFormatVersion({
  zylosDir = ZYLOS_DIR,
  version = CURRENT_INSTRUCTION_FORMAT_VERSION,
  io = {},
} = {}) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('instruction format version must be a positive integer');
  }
  const filePath = instructionFormatVersionPath({ zylosDir });
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  const openSync = io.openSync ?? fs.openSync;
  const fsyncSync = io.fsyncSync ?? fs.fsyncSync;
  const closeSync = io.closeSync ?? fs.closeSync;
  const unlinkSync = io.unlinkSync ?? fs.unlinkSync;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    writeFileSync(tempPath, `${version}\n`, 'utf8');
    fd = openSync(tempPath, 'r');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { }
    try { unlinkSync(tempPath); } catch { }
  }
  return { version, filePath };
}

function declaration(runtime) {
  if (!DECLARATIONS.has(runtime)) throw new TypeError(`Unsupported runtime: ${runtime}`);
  return DECLARATIONS.get(runtime);
}

export function instructionPaths(runtime, options) {
  return instructionPathsFor(declaration(runtime), options);
}

export function instructionTargets({ zylosDir = ZYLOS_DIR } = {}) {
  const targets = new Map();
  for (const { template, output } of DECLARATIONS.values()) {
    const previous = targets.get(output);
    if (previous) {
      if (previous.template !== template) throw new Error(`Instruction output ${output} has two templates`);
      continue;
    }
    targets.set(output, { template, output, ...instructionPathsFor({ template, output }, { zylosDir }) });
  }
  return [...targets.values()];
}

function templateTargets(targets) {
  return [...new Set(targets.map(target => target.template))]
    .map(template => targets.find(target => target.template === template));
}

export function isSplitInstructionsActive({ zylosDir = ZYLOS_DIR } = {}) {
  return fs.existsSync(instructionAssetPaths({ zylosDir }).markerPath);
}

export function needsRebuild(runtime, { zylosDir = ZYLOS_DIR } = {}) {
  const paths = instructionPaths(runtime, { zylosDir });
  if (!fs.existsSync(paths.markerPath)) return false;
  return leafNeedsRebuild(paths);
}

export function buildInstructionFile(runtime, options) {
  return buildInstructionFor(declaration(runtime), options);
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

export function getInstructionFilePath(runtime, options = {}) {
  return instructionPaths(runtime, options).outputPath;
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const existingMode = fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : null;
  try {
    fs.writeFileSync(tmpPath, content);
    if (existingMode !== null) fs.chmodSync(tmpPath, existingMode);
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
  const paths = instructionAssetPaths({ zylosDir });
  fs.mkdirSync(paths.instructionsDir, { recursive: true });
  for (const { template, systemPath } of templateTargets(instructionTargets({ zylosDir }))) {
    const source = path.join(templatesDir, `${template}-system.md`);
    if (!fs.existsSync(source)) throw new Error(`System instruction template not found: ${source}`);
    atomicWrite(systemPath, fs.readFileSync(source));
  }
  atomicWrite(paths.assemblerPath, fs.readFileSync(assemblerSource));
  return paths.instructionsDir;
}

function splitTransactionRoots(zylosDir) {
  return [path.resolve(zylosDir), instructionAssetPaths({ zylosDir }).instructionsDir];
}

export function hasSplitTransactionResidue(zylosDir) {
  for (const root of splitTransactionRoots(zylosDir)) {
    try {
      if (fs.readdirSync(root).some(name => name.includes('.split-txn.'))) return true;
    } catch { }
  }
  return false;
}

function cleanupSplitTemps(zylosDir) {
  const instancePath = path.resolve(zylosDir);
  let ownedRoot;
  try { ownedRoot = fs.realpathSync(instancePath); } catch { return; }
  for (const root of splitTransactionRoots(zylosDir)) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.includes('.split-txn.')) continue;
      // Backups are recovery records, not disposable temporary files.
      if (name.endsWith('.bak')) continue;
      try {
        const relative = path.relative(instancePath, path.join(root, name));
        removeOwnedTree(ownedRoot, path.join(ownedRoot, relative));
      } catch { }
    }
  }
}

export function recoverSplitTransaction(zylosDir, faultInjector = () => {}) {
  const markerPath = instructionAssetPaths({ zylosDir }).markerPath;
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
      const existingMode = fs.existsSync(entry.path) ? fs.statSync(entry.path).mode & 0o777 : null;
      fs.writeFileSync(stagePath, entry.content);
      staged.push({ ...entry, stagePath });
      if (existingMode !== null) fs.chmodSync(stagePath, existingMode);
    }
    faultInjector('stage:marker');
    markerStage = `${markerPath}.split-txn.${token}`;
    const marker = JSON.parse(markerContent);
    marker.transactionId = token;
    fs.writeFileSync(markerStage, JSON.stringify(marker, null, 2) + '\n', 'utf8');
    if (fs.existsSync(markerPath)) fs.chmodSync(markerStage, fs.statSync(markerPath).mode & 0o777);

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

function readSystemEntries(targets, templatesDir) {
  return templateTargets(targets).map(({ template, systemPath }) => ({
    name: `${template}-system`,
    path: systemPath,
    content: fs.readFileSync(path.join(templatesDir, `${template}-system.md`), 'utf8'),
  }));
}

function migratedInstructionEntries({
  zylosDir,
  templatesDir,
  assemblerSource,
  userContent,
  generatedAt,
}) {
  const assets = instructionAssetPaths({ zylosDir });
  const targets = instructionTargets({ zylosDir });
  const systemEntries = readSystemEntries(targets, templatesDir);
  const systems = new Map(systemEntries.map(entry => [entry.path, entry.content]));
  const entries = [
    { name: 'user', path: assets.userPath, content: userContent },
    ...systemEntries,
    { name: 'assembler', path: assets.assemblerPath, content: fs.readFileSync(assemblerSource) },
  ];
  for (const paths of targets) {
    const systemShadow = `${paths.systemPath}.split-render.${process.pid}`;
    const userShadow = `${paths.userPath}.split-render.${process.pid}`;
    fs.mkdirSync(path.dirname(systemShadow), { recursive: true });
    fs.writeFileSync(systemShadow, systems.get(paths.systemPath), 'utf8');
    fs.writeFileSync(userShadow, userContent, 'utf8');
    try {
      const content = renderInstruction({ systemPath: systemShadow, userPath: userShadow, generatedAt })
        .replaceAll(path.resolve(systemShadow), path.resolve(paths.systemPath))
        .replaceAll(path.resolve(userShadow), path.resolve(paths.userPath));
      entries.push({ name: `${paths.template}-output`, path: paths.outputPath, content });
    } finally {
      try { fs.unlinkSync(systemShadow); } catch { }
      try { fs.unlinkSync(userShadow); } catch { }
    }
  }
  return entries;
}

/**
 * Activate split instructions for a legacy installation after the migration
 * command has independently classified and conserved its user content.
 * This is deliberately separate from activateFreshSplitInstructions: the
 * fresh path must keep its legacy-artifact refusal gate.
 */
export function activateMigratedSplitInstructions({
  zylosDir = ZYLOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  assemblerSource = ASSEMBLER_SOURCE,
  userContent,
  migrationMeta,
  faultInjector,
  now = new Date(),
} = {}) {
  if (typeof userContent !== 'string') throw new TypeError('userContent must be a string');
  if (!migrationMeta || typeof migrationMeta !== 'object' || Array.isArray(migrationMeta)) {
    throw new TypeError('migrationMeta must be an object');
  }
  recoverSplitTransaction(zylosDir, faultInjector);
  const assets = instructionAssetPaths({ zylosDir });
  if (fs.existsSync(assets.markerPath)) {
    return { active: true, alreadyActive: true, markerPath: assets.markerPath };
  }
  const entries = migratedInstructionEntries({
    zylosDir,
    templatesDir,
    assemblerSource,
    userContent,
    generatedAt: now,
  });
  const marker = {
    schemaVersion: SPLIT_MARKER_VERSION,
    activatedAt: now.toISOString(),
    seedSha256: crypto.createHash('sha256').update(userContent).digest('hex'),
    migration: migrationMeta,
  };
  commitEntries(entries, assets.markerPath, JSON.stringify(marker, null, 2) + '\n', faultInjector);
  return { active: true, markerPath: assets.markerPath };
}

export function activateFreshSplitInstructions({
  zylosDir = ZYLOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  assemblerSource = ASSEMBLER_SOURCE,
  faultInjector,
  versionIo,
} = {}) {
  const hadTransactionResidue = hasSplitTransactionResidue(zylosDir);
  recoverSplitTransaction(zylosDir, faultInjector);
  const assets = instructionAssetPaths({ zylosDir });
  if (fs.existsSync(assets.markerPath)) {
    return refreshSplitInstructions({ zylosDir, templatesDir, assemblerSource, faultInjector });
  }

  const targets = instructionTargets({ zylosDir });
  const legacyArtifacts = [assets.userPath, ...targets.map(target => target.outputPath)];
  if (!hadTransactionResidue && legacyArtifacts.some(filePath => fs.existsSync(filePath))) {
    deployInstructionAssets({ zylosDir, templatesDir, assemblerSource });
    return { active: false, pendingMigration: true, markerPath: assets.markerPath };
  }

  const userContent = fs.existsSync(assets.userPath)
    ? fs.readFileSync(assets.userPath, 'utf8')
    : fs.readFileSync(path.join(templatesDir, 'ZYLOS.md'), 'utf8');
  const systemEntries = readSystemEntries(targets, templatesDir);
  const systems = new Map(systemEntries.map(entry => [entry.path, entry.content]));
  const now = new Date();
  const entries = [
    ...systemEntries,
    { name: 'assembler', path: assets.assemblerPath, content: fs.readFileSync(assemblerSource) },
  ];
  if (!fs.existsSync(assets.userPath)) {
    entries.push({ name: 'seed', path: assets.userPath, content: userContent });
  }
  for (const paths of targets) {
    const systemShadow = `${paths.systemPath}.split-render.${process.pid}`;
    const userShadow = `${paths.userPath}.split-render.${process.pid}`;
    fs.mkdirSync(path.dirname(systemShadow), { recursive: true });
    fs.writeFileSync(systemShadow, systems.get(paths.systemPath), 'utf8');
    fs.writeFileSync(userShadow, userContent, 'utf8');
    try {
      const content = renderInstruction({ systemPath: systemShadow, userPath: userShadow, generatedAt: now })
        .replaceAll(path.resolve(systemShadow), path.resolve(paths.systemPath))
        .replaceAll(path.resolve(userShadow), path.resolve(paths.userPath));
      entries.push({ name: `${paths.template}-output`, path: paths.outputPath, content });
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
  commitEntries(entries, assets.markerPath, JSON.stringify(marker, null, 2) + '\n', faultInjector);
  try {
    writeInstructionFormatVersion({ zylosDir, io: versionIo });
    return { active: true, markerPath: assets.markerPath, versionWritten: true, versionWriteError: null };
  } catch (versionWriteError) {
    return { active: true, markerPath: assets.markerPath, versionWritten: false, versionWriteError };
  }
}

export function refreshSplitInstructions({
  zylosDir = ZYLOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  assemblerSource = ASSEMBLER_SOURCE,
  faultInjector,
} = {}) {
  recoverSplitTransaction(zylosDir, faultInjector);
  const assets = instructionAssetPaths({ zylosDir });
  if (!fs.existsSync(assets.markerPath)) {
    deployInstructionAssets({ zylosDir, templatesDir, assemblerSource });
    return { active: false, pendingMigration: true, markerPath: assets.markerPath };
  }
  const marker = JSON.parse(fs.readFileSync(assets.markerPath, 'utf8'));
  const userContent = fs.readFileSync(assets.userPath, 'utf8');
  const now = new Date();
  const entries = [];
  const systems = new Map();
  for (const paths of instructionTargets({ zylosDir })) {
    const { template } = paths;
    if (!systems.has(template)) {
      const systemContent = fs.readFileSync(path.join(templatesDir, `${template}-system.md`), 'utf8');
      systems.set(template, systemContent);
      entries.push({ name: `${template}-system`, path: paths.systemPath, content: systemContent });
    }
    const systemShadow = `${paths.systemPath}.split-render.${process.pid}`;
    fs.mkdirSync(path.dirname(systemShadow), { recursive: true });
    fs.writeFileSync(systemShadow, systems.get(template), 'utf8');
    try {
      const content = renderInstruction({ systemPath: systemShadow, userPath: paths.userPath, generatedAt: now })
        .replaceAll(path.resolve(systemShadow), path.resolve(paths.systemPath));
      entries.push({ name: `${paths.template}-output`, path: paths.outputPath, content });
    } finally {
      try { fs.unlinkSync(systemShadow); } catch { }
    }
  }
  entries.push({ name: 'assembler', path: assets.assemblerPath, content: fs.readFileSync(assemblerSource) });
  marker.refreshedAt = now.toISOString();
  marker.userSha256 = crypto.createHash('sha256').update(userContent).digest('hex');
  commitEntries(entries, assets.markerPath, JSON.stringify(marker, null, 2) + '\n', faultInjector);
  return { active: true, markerPath: assets.markerPath };
}
