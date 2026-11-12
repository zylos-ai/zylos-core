#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';
import { withMemoryLock, readCurrentRunId, readSyncMarker } from './sync-lock.js';
import { memoryError, options, exitCode, isMain } from './sync-cli.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const invalidPath = () => memoryError('INVALID_MEMORY_PATH', 'Expected an existing regular file without symlinks below the resolved memory directory');

function relativePath(value) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) throw invalidPath();
  const rel = value.trim();
  if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:(?:[\\/]|$)/.test(rel) ||
      rel.split('/').some(part => !part || part === '.' || part === '..')) throw invalidPath();
  return rel;
}

function resolveFile(root, rel, io) {
  try {
    const realRoot = io.realpathSync(path.join(root, 'memory'));
    if (!io.lstatSync(realRoot).isDirectory()) throw invalidPath();
    let candidate = realRoot;
    for (const part of rel.split('/')) {
      candidate = path.join(candidate, part);
      if (io.lstatSync(candidate).isSymbolicLink()) throw invalidPath();
    }
    const real = io.realpathSync(candidate);
    const inside = path.relative(realRoot, real);
    if (!inside || inside.split(path.sep)[0] === '..' || path.isAbsolute(inside)) throw invalidPath();
    const stat = io.lstatSync(real);
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalidPath();
    return { real, stat };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw memoryError('MEMORY_FILE_NOT_FOUND', 'Memory file does not exist');
    throw error;
  }
}

async function writeScope(rel, env) {
  const configUrl = pathToFileURL(resolveCoreConfigModule());
  const [config, paths] = await Promise.all([
    import(configUrl.href),
    import(new URL('./session-group-paths.js', configUrl).href),
  ]);
  const parts = rel.split('/');
  let group = 'origin';
  if (parts[0] === 'session-groups') {
    if (parts.length < 3) throw memoryError('INVALID_INPUT', 'Expected a group key and memory file');
    group = paths.assertSessionGroup(parts[1]);
  }
  return { runDir: paths.groupRunDir(group, env), group, readSessionMode: config.readSessionMode };
}

/** Return one file snapshot's text and raw-byte hash without taking a lock. */
export function readMemory({ path: inputPath, env = process.env } = {}, { io = fs } = {}) {
  const rel = relativePath(inputPath);
  const root = env.ZYLOS_DIR || path.join(env.HOME || process.env.HOME, 'zylos');
  const { real } = resolveFile(root, rel, io);
  const bytes = io.readFileSync(real);
  return { path: rel, sha256: sha256(bytes), text: bytes.toString('utf8') };
}

/** Save an existing memory file; Sync admission and publication share its lock. */
export async function writeMemory({ path: inputPath, sha256: expected, content, env = process.env, waitMs } = {},
  { currentRunId = readCurrentRunId, io = fs } = {}) {
  const rel = relativePath(inputPath);
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) ||
      !(typeof content === 'string' || Buffer.isBuffer(content))) {
    throw memoryError('INVALID_INPUT', 'Expected a sha256 hex digest and new content');
  }
  if (content.length === 0) throw memoryError('INVALID_INPUT', 'New content must not be empty');
  const root = env.ZYLOS_DIR || path.join(env.HOME || process.env.HOME, 'zylos');
  resolveFile(root, rel, io);
  const scope = await writeScope(rel, env);
  return withMemoryLock(scope.runDir, async () => {
    const sessionGroup = scope.group === 'origin' && scope.readSessionMode().mode !== 'multi' ? null : scope.group;
    const liveRun = await currentRunId({ runDir: scope.runDir, sessionGroup });
    const kinds = scope.group === 'origin' ? [sessionGroup ? 'group' : 'global', 'origin'] : ['group'];
    if (kinds.some(kind => readSyncMarker({ runDir: scope.runDir, kind, currentRunId: liveRun }).held)) {
      throw memoryError('SYNC_BUSY', 'Memory Sync is running; retry after it finishes');
    }
    // The target may have changed while waiting for the lock or observing tmux.
    const { real, stat } = resolveFile(root, rel, io);
    const currentBytes = io.readFileSync(real);
    const currentHash = sha256(currentBytes);
    if (currentHash !== expected) {
      throw memoryError('MEMORY_CONFLICT', 'Memory file changed since it was opened', {
        current: { text: currentBytes.toString('utf8'), sha256: currentHash },
      });
    }
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const temp = path.join(path.dirname(real), `.${path.basename(real)}.${randomBytes(12).toString('hex')}.tmp`);
    let fd, created = false;
    try {
      fd = io.openSync(temp, 'wx', stat.mode & 0o7777);
      created = true;
      io.writeFileSync(fd, bytes);
      // Creation mode is filtered by umask; restore the actual original mode.
      io.fchmodSync(fd, stat.mode & 0o7777);
      io.closeSync(fd);
      fd = undefined;
      io.renameSync(temp, real);
    } finally {
      if (fd !== undefined) io.closeSync(fd);
      if (created) {
        try { io.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    return { path: rel, sha256: sha256(bytes) };
  }, { waitMs });
}

/** JSON entry point for component callers; content arrives as raw stdin bytes. */
export async function runMemoryWriteCli(argv = process.argv.slice(2), {
  env = process.env, currentRunId = readCurrentRunId, waitMs,
  input = () => fs.readFileSync(0), output = text => process.stdout.write(text),
} = {}) {
  try {
    const args = options(argv, ['path', 'sha256'], ['read']);
    if (args.positional.length || args.path === undefined ||
        (args.read ? args.sha256 !== undefined : args.sha256 === undefined)) {
      throw memoryError('INVALID_INPUT', 'Usage: memory-write.js --read --path RELATIVE_PATH | memory-write.js --path RELATIVE_PATH --sha256 EXPECTED_HASH < content');
    }
    const data = args.read ? readMemory({ path: args.path, env }) :
      await writeMemory({ path: args.path, sha256: args.sha256, content: input(), env, waitMs }, { currentRunId });
    output(JSON.stringify({ ok: true, data }) + '\n');
    return 0;
  } catch (cause) {
    const error = { code: cause.code || 'IO_ERROR', message: cause.message };
    if (cause.current) error.current = cause.current;
    output(JSON.stringify({ ok: false, error }) + '\n');
    return exitCode(error.code);
  }
}

if (isMain(import.meta.url)) process.exitCode = await runMemoryWriteCli();
