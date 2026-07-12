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
  if (!fs.existsSync(paths.markerPath)) return true;
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
  atomicWrite(paths.assemblerPath, fs.readFileSync(assemblerSource));
  return paths.instructionsDir;
}

function cleanupSplitTemps(zylosDir) {
  const roots = [path.resolve(zylosDir), instructionPaths('claude', { zylosDir }).instructionsDir];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.includes('.split-txn.')) continue;
      try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { }
    }
  }
}

function commitEntries(entries, markerPath, markerContent, faultInjector = () => {}) {
  const token = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const staged = [];
  const backups = [];
  const applied = [];
  let markerBackup;
  let committed = false;

  try {
    for (const entry of entries) {
      faultInjector(`stage:${entry.name}`);
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      const stagePath = `${entry.path}.split-txn.${token}`;
      fs.writeFileSync(stagePath, entry.content);
      staged.push({ ...entry, stagePath });
    }
    faultInjector('stage:marker');
    const markerStage = `${markerPath}.split-txn.${token}`;
    fs.writeFileSync(markerStage, markerContent, 'utf8');

    if (fs.existsSync(markerPath)) {
      markerBackup = `${markerPath}.split-txn.${token}.bak`;
      fs.renameSync(markerPath, markerBackup);
    }

    for (const entry of staged) {
      if (fs.existsSync(entry.path)) {
        const backupPath = `${entry.path}.split-txn.${token}.bak`;
        fs.renameSync(entry.path, backupPath);
        backups.push({ path: entry.path, backupPath });
      }
      faultInjector(`rename:${entry.name}`);
      fs.renameSync(entry.stagePath, entry.path);
      applied.push(entry);
    }

    faultInjector('rename:marker');
    fs.renameSync(markerStage, markerPath);
    committed = true;
    // Cleanup happens after the commit record is visible. A cleanup-only
    // failure must not report the committed transaction as failed; retries
    // sweep stale transaction files before doing any work.
    try { faultInjector('cleanup'); } catch { }
  } catch (error) {
    if (!committed) {
      for (const entry of [...applied].reverse()) {
        try { fs.unlinkSync(entry.path); } catch { }
      }
      for (const backup of [...backups].reverse()) {
        try { fs.renameSync(backup.backupPath, backup.path); } catch { }
      }
      if (markerBackup) {
        try { fs.renameSync(markerBackup, markerPath); } catch { }
      } else {
        try { fs.unlinkSync(markerPath); } catch { }
      }
    }
    throw error;
  } finally {
    for (const entry of staged) {
      try { fs.unlinkSync(entry.stagePath); } catch { }
    }
    for (const backup of backups) {
      try { fs.unlinkSync(backup.backupPath); } catch { }
    }
    try { fs.unlinkSync(`${markerPath}.split-txn.${token}`); } catch { }
    try { if (markerBackup) fs.unlinkSync(markerBackup); } catch { }
  }
}

export function activateFreshSplitInstructions({
  zylosDir = ZYLOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  assemblerSource = ASSEMBLER_SOURCE,
  faultInjector,
} = {}) {
  cleanupSplitTemps(zylosDir);
  const claude = instructionPaths('claude', { zylosDir });
  if (fs.existsSync(claude.markerPath)) {
    return refreshSplitInstructions({ zylosDir, templatesDir, assemblerSource, faultInjector });
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
  cleanupSplitTemps(zylosDir);
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
  entries.push({ name: 'assembler', path: claude.assemblerPath, content: fs.readFileSync(assemblerSource) });
  marker.refreshedAt = now.toISOString();
  marker.userSha256 = crypto.createHash('sha256').update(userContent).digest('hex');
  commitEntries(entries, claude.markerPath, JSON.stringify(marker, null, 2) + '\n', faultInjector);
  return { active: true, markerPath: claude.markerPath };
}
