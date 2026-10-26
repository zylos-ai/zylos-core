#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSessionMode } from './config.js';
import { groupRunDir, zylosRoot } from './session-group-paths.js';
import { openTmuxConnection } from './runtime/tmux-connection.js';
import { observeSessionTarget } from './runtime/session-target.js';
import { withMemoryLock } from '../../skills/zylos-memory/scripts/sync-lock.js';

export const MIGRATION_ID = 'references-layout-v1';
const SELF = fileURLToPath(import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url))).version;
const error = (code, message, persisted = [], extra = {}) => Object.assign(new Error(message), { code, persisted, ...extra });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = cause => cause.code === 'ENOENT';

function syncDir(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durableFile(filename, bytes) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function publishFile(filename, bytes, { createOnly = false, checkpoint = () => {}, label = 'file' } = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    durableFile(temporary, bytes);
    checkpoint(`${label}:before-publish`);
    if (createOnly) fs.linkSync(temporary, filename);
    else fs.renameSync(temporary, filename);
    committed = true;
    checkpoint(`${label}:after-publish`);
    syncDir(path.dirname(filename));
  } catch (cause) {
    if (createOnly && cause.code === 'EEXIST') return false;
    throw error('WRITE_FAILED', cause.message, committed ? null : []);
  } finally {
    try { fs.unlinkSync(temporary); }
    catch (cause) { if (!absent(cause)) throw error('WRITE_FAILED', cause.message, committed ? null : []); }
  }
  return true;
}
function readRegular(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw error('READ_FAILED', 'Expected a regular file');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const actual = fs.fstatSync(fd);
    if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw error('READ_FAILED', 'File changed during open');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function backupState(backupDir) {
  let stat;
  try {
    stat = fs.lstatSync(backupDir);
  } catch (cause) { return absent(cause) ? 'absent' : 'invalid'; }
  try {
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'invalid';
    readRegular(path.join(backupDir, 'references.md'));
    return 'valid';
  } catch { return 'invalid'; }
}

/** Called only while holding origin F8. No staging directory is reused. */
function ensureValidBackupLocked({ backupDir, references, checkpoint = () => {} }) {
  const state = backupState(backupDir);
  if (state === 'valid') return false;
  if (state === 'invalid') throw error('BACKUP_INVALID', 'Existing references backup is invalid', [], { path: backupDir });
  let original;
  try { original = readRegular(references); }
  catch (cause) { throw error(absent(cause) ? 'REFERENCES_MISSING' : 'READ_FAILED', cause.message); }
  let published = false;
  try {
    fs.mkdirSync(path.dirname(backupDir), { recursive: true, mode: 0o700 });
    const staging = fs.mkdtempSync(`${backupDir}.staging-`);
    checkpoint('backup:started');
    durableFile(path.join(staging, 'references.md'), original);
    checkpoint('backup:copied');
    if (!readRegular(path.join(staging, 'references.md')).equals(original)) throw Error('Backup readback differs');
    checkpoint('backup:verified');
    syncDir(staging);
    checkpoint('backup:before-publish');
    fs.renameSync(staging, backupDir);
    published = true;
    checkpoint('backup:after-publish');
    syncDir(path.dirname(backupDir));
  } catch (cause) {
    throw error('BACKUP_WRITE_FAILED', cause.message, published ? null : []);
  }
  return true;
}

async function observeOrigin() {
  let connection;
  try {
    connection = await openTmuxConnection();
    return await observeSessionTarget({ sessionGroup: 'origin', connection });
  } finally { await connection?.close(); }
}
async function openTransition() {
  const { getModeTransition } = await import('../../skills/comm-bridge/scripts/c4-db.js');
  return getModeTransition();
}

export function createMigration({ env = process.env, now = Date.now, version = VERSION,
  readMode = readSessionMode, readTransition = openTransition, observe = observeOrigin,
  lock = withMemoryLock, checkpoint = () => {} } = {}) {
  const root = zylosRoot(env);
  const memory = path.join(root, 'memory');
  const migrationDir = path.join(root, '.zylos', 'migrations');
  const recordPath = path.join(migrationDir, `${MIGRATION_ID}.json`);
  const backupDir = path.join(migrationDir, `${MIGRATION_ID}.backup`);
  const references = path.join(memory, 'references.md');
  function readRecord() {
    let record;
    try { record = JSON.parse(readRegular(recordPath).toString('utf8')); }
    catch (cause) { throw error('RECORD_UNREADABLE', cause.message); }
    if (!record || record.v !== 1 || record.migrationId !== MIGRATION_ID || !['pending', 'done'].includes(record.state) ||
        !Number.isInteger(record.attempts) || record.attempts < 0) {
      throw error('RECORD_UNREADABLE', 'Invalid migration record');
    }
    return record;
  }
  function status() {
    try { const record = readRecord(); return { state: record.state, attempts: record.attempts }; }
    catch {
      try { fs.lstatSync(recordPath); } catch (cause) { if (absent(cause)) return { state: 'absent' }; }
      return { state: 'unreadable', warning: 'RECORD_UNREADABLE' };
    }
  }
  function mechanical(requireBackup) {
    let bytes;
    const missingPaths = [];
    try { bytes = readRegular(references); } catch { missingPaths.push('memory/references.md'); }
    const text = String(bytes || '');
    const indexed = [];
    for (const [, code, angle, link] of text.matchAll(/`([^`\n]+)`|\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
      const value = code || angle || link;
      if (/^(?:memory\/)?reference\//.test(value)) indexed.push(value);
    }
    const indexedPaths = [...new Set(indexed.map(value => `memory/${value.replace(/^memory\//, '')}`))];
    for (const indexed of indexedPaths) {
      const target = path.resolve(root, indexed);
      if (!target.startsWith(`${path.join(memory, 'reference')}${path.sep}`)) { missingPaths.push(indexed); continue; }
      try { fs.accessSync(target, fs.constants.R_OK); } catch { missingPaths.push(indexed); }
    }
    const backupPresent = backupState(backupDir) === 'valid';
    if (requireBackup && !backupPresent) missingPaths.push(path.relative(root, backupDir));
    return { referencesSha256: bytes ? hash(bytes) : null, indexedPaths, missingPaths, backupPresent };
  }
  function ensure({ createdBy, freshInstall = false } = {}) {
    if (!['upgrade', 'init'].includes(createdBy)) throw error('INVALID_INPUT', 'created-by must be upgrade or init');
    const existing = status();
    if (existing.state !== 'absent') return existing;
    const check = freshInstall ? mechanical(false) : null;
    const done = freshInstall && check.missingPaths.length === 0;
    const timestamp = now();
    const record = { v: 1, migrationId: MIGRATION_ID, state: done ? 'done' : 'pending', createdAt: timestamp,
      createdBy, coreVersion: version, updatedAt: timestamp, attempts: 0, backupPath: null,
      completedAt: done ? timestamp : null, evidence: done ? { kind: 'fresh_install', agent: null, mechanical: check } : null };
    publishFile(recordPath, `${JSON.stringify(record)}\n`, { createOnly: true, checkpoint, label: 'record' });
    return status();
  }
  async function authorize(command) {
    const record = readRecord();
    if (record.state !== 'pending') throw error(command === 'complete' ? 'ALREADY_DONE' : 'MIGRATION_DONE', 'Migration is already complete');
    let mode;
    try {
      mode = (await readMode()).mode;
      if (mode === null) mode = 'single';
      if (!['single', 'multi'].includes(mode) || await readTransition()) throw Error('Session mode unavailable or transitioning');
    } catch (cause) { throw error('MODE_UNAVAILABLE', cause.message); }
    const grouped = Object.hasOwn(env, 'ZYLOS_SESSION_GROUP');
    if ((mode === 'multi' && env.ZYLOS_SESSION_GROUP !== 'origin') || (mode === 'single' && grouped)) {
      throw error('NOT_MAIN_SESSION', 'Migration requires the current main session');
    }
    let live;
    try { live = await observe(); } catch (cause) { throw error('RUN_MISMATCH', cause.message); }
    if (!live?.present) throw error('RUN_MISMATCH', 'Main session is absent');
    if ((mode === 'multi' && live.rawF2?.ZYLOS_SESSION_GROUP !== 'origin') ||
        (mode === 'single' && Object.hasOwn(live.rawF2 || {}, 'ZYLOS_SESSION_GROUP'))) {
      throw error('NOT_MAIN_SESSION', 'Main session environment differs from current mode');
    }
    if (!env.ZYLOS_RUN_ID || !live.present || live.runId !== env.ZYLOS_RUN_ID || !live.ready || live.f3?.runId !== env.ZYLOS_RUN_ID) {
      throw error('RUN_MISMATCH', 'Main session run has changed or is not ready');
    }
    return record;
  }
  function targetPath(relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) {
      throw error('PATH_NOT_ALLOWED', 'Invalid migration path');
    }
    const normalized = path.posix.normalize(relative);
    if (normalized !== 'references.md' && !normalized.startsWith('reference/')) throw error('PATH_NOT_ALLOWED', 'Migration path is outside references');
    const target = path.resolve(memory, normalized);
    if (!target.startsWith(`${memory}${path.sep}`)) throw error('PATH_NOT_ALLOWED', 'Migration path escapes memory');
    // Reject symlink ancestors as well as symlink targets, including dangling links.
    let current = memory;
    for (const part of path.relative(memory, target).split(path.sep)) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) throw error('PATH_NOT_ALLOWED', 'Symlink migration paths are forbidden'); }
      catch (cause) { if (!absent(cause)) throw cause; }
    }
    return { target, normalized };
  }
  async function apply(input, options = {}) {
    return lock(groupRunDir('origin', env), async () => {
      await authorize('apply');
      const { target, normalized } = targetPath(input?.path);
      const created = ensureValidBackupLocked({ backupDir, references, checkpoint });
      const persisted = created ? ['w7.backup'] : [];
      if (!(input.expected === null || typeof input.expected === 'string') || typeof input.replacement !== 'string') {
        throw error('INVALID_INPUT', 'Expected a string/null expected and string replacement', persisted);
      }
      let current = null;
      try { current = readRegular(target).toString('utf8'); }
      catch (cause) { if (!absent(cause)) throw error('READ_FAILED', cause.message, persisted); }
      const expected = input.expected;
      let replacement;
      if (expected === null ? current !== null : current === null || (expected === '' ? current !== '' : current.split(expected).length !== 2)) {
        throw error('FRAGMENT_CONFLICT', 'Expected fragment does not match exactly once', persisted);
      }
      replacement = expected === null || expected === '' ? input.replacement : current.replace(expected, () => input.replacement);
      try { publishFile(target, replacement, { checkpoint, label: 'target' }); }
      catch (cause) { if (cause.persisted !== null) cause.persisted = persisted; throw cause; }
      return { path: normalized, backupCreated: created };
    }, options);
  }
  async function complete(summary, options = {}) {
    return lock(groupRunDir('origin', env), async () => {
      const record = await authorize('complete');
      if (typeof summary !== 'string' || !summary.trim() || [...summary].length > 2000) throw error('INVALID_INPUT', 'summary must contain 1–2000 characters');
      const check = mechanical(true);
      const done = check.missingPaths.length === 0;
      const updated = { ...record, attempts: record.attempts + 1, updatedAt: now() };
      if (done) Object.assign(updated, { state: 'done', completedAt: now(), coreVersion: version,
        backupPath: path.relative(root, backupDir), evidence: { kind: 'agent_reorganized',
          agent: { sessionGroup: env.ZYLOS_SESSION_GROUP || '*', runId: env.ZYLOS_RUN_ID, summary }, mechanical: check } });
      publishFile(recordPath, `${JSON.stringify(updated)}\n`, { checkpoint, label: 'record' });
      if (!done) throw error('CHECK_FAILED', 'Migration mechanical checks failed', ['w7.attempts'], { missingPaths: check.missingPaths });
      return { state: 'done', attempts: updated.attempts };
    }, options);
  }
  return { ensure, status, apply, complete };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--id', '--created-by', '--fresh-install', '--summary', '--json'].includes(flag) || flags.has(flag)) throw error('INVALID_INPUT', 'Invalid migration arguments');
    if (['--json', '--fresh-install'].includes(flag)) flags.set(flag, true);
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw error('INVALID_INPUT', `Missing ${flag} value`); flags.set(flag, args[++i]); }
  }
  if (flags.get('--id') !== MIGRATION_ID) throw error('INVALID_INPUT', 'Unknown migration id');
  const allowed = {
    ensure: ['--id', '--created-by', '--fresh-install', '--json'],
    status: ['--id', '--json'], apply: ['--id', '--json'], complete: ['--id', '--summary', '--json'],
  }[command];
  if (!allowed || [...flags.keys()].some(flag => !allowed.includes(flag))) throw error('INVALID_INPUT', 'Invalid flags for migration command');
  const service = createMigration();
  if (command === 'ensure') return service.ensure({ createdBy: flags.get('--created-by'), freshInstall: flags.has('--fresh-install') });
  if (command === 'status') return service.status();
  if (command === 'apply') return service.apply(JSON.parse(fs.readFileSync(0, 'utf8')));
  if (command === 'complete' && flags.get('--summary') === '-') return service.complete(fs.readFileSync(0, 'utf8'));
  throw error('INVALID_INPUT', 'Unknown migration command or missing --summary -');
}

export async function runCli(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  try {
    const data = await main(argv);
    console.log(json ? JSON.stringify({ ok: true, data }) : `OK: ${argv[0]} ${JSON.stringify(data)}`);
  }
  catch (cause) {
    const code = cause.code || 'INVALID_INPUT';
    if (json) console.log(JSON.stringify({ ok: false, error: { code, message: cause.message, persisted: cause.persisted ?? (cause.persisted === null ? null : []),
      ...(cause.missingPaths ? { missingPaths: cause.missingPaths } : {}), ...(cause.path ? { path: cause.path } : {}) } }));
    else {
      console.error(`Error [${code}]: ${cause.message}`);
      for (const missing of cause.missingPaths || []) console.error(`Missing path: ${missing}`);
      if (cause.path) console.error(`Backup path: ${cause.path}`);
    }
    process.exitCode = code === 'LOCK_TIMEOUT' ? 2 : code === 'FRAGMENT_CONFLICT' ? 4 : 1;
  }
}

if (process.argv[1] === SELF) await runCli();
