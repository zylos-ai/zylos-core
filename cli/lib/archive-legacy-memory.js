import fs from 'node:fs';
import path from 'node:path';
import { parseSessionGroup } from '../../skills/comm-bridge/scripts/c4-session-group.js';
import { withMemoryLock } from '../../skills/zylos-memory/scripts/memory-lock.js';
import { groupRunDir } from './session-group-paths.js';
import { maintenance } from './upgrade-protection.js';

const inboxName = /^inbox(?:\.[^.]+)?\.md$/;
const retiredAgentNames = new Set(['zylos-global-sync.md', 'zylos-group-sync.md', 'zylos-origin-sync.md']);

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

/** Retire the three installed definitions while preserving their contents and other agents. */
export function archiveLegacyClaudeAgents(zylosDir) {
  const claude = path.join(zylosDir, '.claude');
  if (!readDirectory(claude).some(entry => entry.name === 'agents')) return { status: 'skipped' };
  const source = path.join(claude, 'agents');
  const agents = readDirectory(source).filter(entry => entry.isFile() && retiredAgentNames.has(entry.name));
  if (!agents.length) return { status: 'skipped' };
  const metadata = ensureArchiveDirectory(zylosDir, '.zylos');
  const archive = ensureArchiveDirectory(metadata, 'retired-claude-agents');
  for (const { name } of agents) moveFileToArchive(source, archive, name);
  return { message: `Archived ${agents.length} retired Claude agent definition(s)` };
}
