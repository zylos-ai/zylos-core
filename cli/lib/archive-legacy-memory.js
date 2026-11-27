import fs from 'node:fs';
import path from 'node:path';
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
    maintenance.fsyncDir(sourceDir);
    return;
  }
}

const inboxEntries = directory => readDirectory(directory).filter(entry => entry.isFile() && inboxName.test(entry.name));

/** Called after the compensation cutoff and before services start. */
export async function archiveLegacyInbox(zylosDir) {
  let memory;
  try { memory = fs.realpathSync(path.join(zylosDir, 'memory')); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'skipped', message: 'No legacy inbox files' };
    throw error;
  }
  const groupsDir = path.join(memory, 'session-groups');
  let moved = 0;
  const archiveScope = async (group, sourceDir) => {
    if (!inboxEntries(sourceDir).length) return;
    await withMemoryLock(groupRunDir(group, { ZYLOS_DIR: zylosDir }), () => {
      const entries = inboxEntries(sourceDir);
      if (!entries.length) return;
      const archive = ensureArchiveDirectory(memory, 'archive');
      const inbox = ensureArchiveDirectory(archive, 'inbox');
      const destination = ensureArchiveDirectory(inbox, group);
      for (const { name } of entries) {
        moveFileToArchive(sourceDir, destination, name);
        moved++;
      }
    });
  };
  await archiveScope('origin', memory);
  for (const entry of readDirectory(groupsDir)) {
    if (entry.isDirectory() && parseSessionGroup(entry.name)) {
      await archiveScope(entry.name, path.join(groupsDir, entry.name));
    }
  }
  return moved ? { message: `Archived ${moved} legacy inbox file(s)` } : { status: 'skipped', message: 'No legacy inbox files' };
}

/** Archive adapter-owned assets without touching other project files. */
export async function archiveRetiredRuntimeFiles(zylosDir) {
  let moved = 0;
  for (const id of SUPPORTED_RUNTIMES) {
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
      moveFileToArchive(source, archive, name);
      moved++;
    }
  }
  return moved ? { message: `Archived ${moved} retired runtime file(s)` } : { status: 'skipped' };
}
