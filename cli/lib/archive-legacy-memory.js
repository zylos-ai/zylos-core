import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { templateHashes } from '../../skills/activity-monitor/scripts/global-memory-handover.js';
import { parseSessionGroup } from '../../skills/comm-bridge/scripts/c4-session-group.js';
import { withMemoryLock } from '../../skills/zylos-memory/scripts/memory-lock.js';
import { groupRunDir } from './session-group-paths.js';
import { maintenance } from './upgrade-protection.js';
import { getRuntime, SUPPORTED_RUNTIMES } from './runtime/index.js';
import { UNSUPPORTED } from './runtime/contract.js';

const inboxName = /^inbox(?:\.[^.]+)?\.md$/;

function statIfPresent(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function readDirectory(directory) {
  const stat = statIfPresent(directory);
  if (!stat) return [];
  if (!stat.isDirectory()) throw Error(`Expected a directory at ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true });
}

function ensureArchiveDirectory(parent, name) {
  const directory = path.join(parent, name);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(directory).isDirectory()) throw Error(`Expected an archive directory at ${directory}`);
  maintenance.fsyncDir(parent);
  return directory;
}

function moveFileToArchive(sourceDir, archiveDir, name) {
  const source = path.join(sourceDir, name);
  const original = fs.lstatSync(source, { bigint: true });
  if (!original.isFile()) throw Error(`Expected a regular file at ${source}`);
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { maintenance.fsyncFd(fd); } finally { fs.closeSync(fd); }

  for (let suffix = 0; ; suffix++) {
    const target = path.join(archiveDir, suffix ? `${name.slice(0, -3)}.archive-${suffix}.md` : name);
    try { fs.linkSync(source, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = statIfPresent(target);
      // If finalization stopped after linking, finish moving that same inode.
      if (!existing || existing.dev !== original.dev || existing.ino !== original.ino) continue;
    }
    maintenance.fsyncDir(archiveDir);
    fs.unlinkSync(source);
    try { maintenance.fsyncDir(sourceDir); }
    catch (error) {
      // Keep the source available for retry if the final directory sync fails.
      fs.linkSync(target, source);
      throw error;
    }
    return;
  }
}

async function archiveLegacyScopedFiles(zylosDir, kind, fileNames, beforeArchive = () => {}) {
  const noFiles = { status: 'skipped', message: `No legacy ${kind} files`, failures: [] };
  let memory;
  try { memory = fs.realpathSync(path.join(zylosDir, 'memory')); }
  catch (error) {
    if (error.code === 'ENOENT') return noFiles;
    return { status: 'skipped', failures: [`legacy ${kind} directory (${error.message})`] };
  }
  const groupsDir = path.join(memory, 'session-groups');
  const failures = [];
  let moved = 0;
  const archiveScope = async (group, sourceDir) => {
    try {
      if (!fileNames(sourceDir).length) return;
      await withMemoryLock(groupRunDir(group, { ZYLOS_DIR: zylosDir }), () => {
        const names = fileNames(sourceDir);
        if (!names.length) return;
        const archive = ensureArchiveDirectory(memory, 'archive');
        const destination = ensureArchiveDirectory(ensureArchiveDirectory(archive, kind), group);
        for (const name of names) {
          beforeArchive(sourceDir, name);
          moveFileToArchive(sourceDir, destination, name);
          moved++;
        }
      });
    } catch (error) {
      failures.push(`legacy ${kind} for ${group} (${error.message})`);
    }
  };
  await archiveScope('origin', memory);
  let groups = [];
  try { groups = readDirectory(groupsDir); }
  catch (error) { failures.push(`legacy ${kind} group directory (${error.message})`); }
  for (const entry of groups) {
    if (entry.isDirectory() && parseSessionGroup(entry.name)) {
      await archiveScope(entry.name, path.join(groupsDir, entry.name));
    }
  }
  if (moved) return { message: `Archived ${moved} legacy ${kind} file(s)`, failures };
  if (failures.length) return { status: 'skipped', failures };
  return noFiles;
}

/** Called after the compensation cutoff and before services start. */
export function archiveLegacyInbox(zylosDir) {
  return archiveLegacyScopedFiles(zylosDir, 'inbox', directory => readDirectory(directory)
    .filter(entry => entry.isFile() && inboxName.test(entry.name)).map(entry => entry.name));
}

function readRegularFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Error(`Expected a regular file at ${file}`);
    return { bytes: fs.readFileSync(fd), stat };
  } finally { fs.closeSync(fd); }
}

function carryStateIntoHandoff(sourceDir, name) {
  const state = readRegularFile(path.join(sourceDir, name));
  const hash = createHash('sha256').update(state.bytes.toString('utf8').replace(/\s/gu, '')).digest('hex');
  if (templateHashes.has(hash)) return;

  const file = path.join(sourceDir, 'handoff.md');
  let handoff;
  try { handoff = readRegularFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  // Use the source date so an interrupted upgrade recognizes its existing section on retry.
  const date = state.stat.mtime.toISOString().slice(0, 10);
  const section = Buffer.concat([
    Buffer.from(`## Carried over from retired state.md (${date})\n\n` +
      'Check each item against its current record; keep unfinished items in the next handoff.\n\n'),
    state.bytes,
  ]);
  const existing = handoff?.bytes ?? Buffer.alloc(0);
  let expected = existing;
  if (!existing.includes(section)) {
    expected = Buffer.concat([existing, Buffer.from(existing.length ? '\n\n' : ''), section]);
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      try {
        fs.writeFileSync(fd, expected);
        // Startup uses the handoff mtime as its conversation history cutoff.
        const timestamp = handoff?.stat ?? state.stat;
        fs.futimesSync(fd, timestamp.atimeMs / 1000, timestamp.mtimeMs / 1000);
        maintenance.fsyncFd(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (!readRegularFile(file).bytes.equals(expected)) throw Error(`Could not verify migrated handoff at ${file}`);
  maintenance.fsyncDir(sourceDir);
}

/** Preserve edited state in its scope handoff before retiring the old file. */
export function archiveLegacyState(zylosDir) {
  const name = 'state.md';
  return archiveLegacyScopedFiles(zylosDir, 'state', directory =>
    statIfPresent(path.join(directory, name)) ? [name] : [], carryStateIntoHandoff);
}

/** Archive adapter-owned assets without touching other project files. */
export async function archiveRetiredRuntimeFiles(zylosDir) {
  const failures = [];
  let moved = 0;
  for (const id of SUPPORTED_RUNTIMES) {
    try {
      const { install } = await getRuntime(id);
      const retired = install.retiredProjectFiles;
      if (retired === UNSUPPORTED) continue;
      let source = zylosDir;
      for (const part of retired.source) {
        source = path.join(source, part);
        if (!statIfPresent(source)?.isDirectory()) { source = null; break; }
      }
      if (!source) continue;
      const names = readDirectory(source).filter(entry => entry.isFile() && retired.names.includes(entry.name));
      if (!names.length) continue;
      let archive = zylosDir;
      for (const part of retired.archive) archive = ensureArchiveDirectory(archive, part);
      for (const { name } of names) {
        try {
          moveFileToArchive(source, archive, name);
          moved++;
        } catch (error) {
          failures.push(`retired ${id} file ${name} (${error.message})`);
        }
      }
    } catch (error) {
      failures.push(`retired ${id} files (${error.message})`);
    }
  }
  return moved ? { message: `Archived ${moved} retired runtime file(s)`, failures } : { status: 'skipped', failures };
}
