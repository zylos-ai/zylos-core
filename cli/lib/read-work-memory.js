import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runDirFromEnv, groupMemoryDir, zylosRoot } from './session-group-paths.js';
import { withMemoryLock as memoryLock } from '../../skills/zylos-memory/scripts/sync-lock.js';

const OUTPUT_LIMIT = 32 * 1024;
const segmentName = /^inbox\.(\d{8}T\d{9}Z(?:-[1-9]\d*)?)\.md$/;
const fail = (code, message, parts = []) => Object.assign(new Error(message), { code, parts, persisted: [] });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = bytes => ({ bytes: bytes.length, sha256: hash(bytes) });
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export function parseReadWorkMemoryArgs(argv) {
  let json = false, timeoutMs = 10000, timeoutSeen = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json' && !json) json = true;
    else if (argv[i] === '--timeout-ms' && !timeoutSeen && /^\d+$/.test(argv[i + 1] || '')) {
      timeoutSeen = true;
      timeoutMs = Number(argv[++i]);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 2000) throw fail('INVALID_ARGS', 'timeout-ms must be an integer greater than 2000');
    } else throw fail('INVALID_ARGS', `Invalid or duplicate argument: ${argv[i]}`);
  }
  return { json, timeoutMs };
}

/** Capture once under F8; formatting and temporary output happen after release. */
export async function readWorkMemory({
  env = process.env, timeoutMs = 10000, json = true,
  withMemoryLock = memoryLock, parseStateHeader, now = Date.now,
  readFile = fs.readFileSync, listFiles = fs.readdirSync,
  writeFile = fs.writeFileSync, temporaryDir = env.TMPDIR || os.tmpdir(),
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 2000) throw fail('INVALID_ARGS', 'timeout-ms must be an integer greater than 2000');
  const deadline = now() + timeoutMs;
  const checkBudget = () => { if (now() >= deadline) throw fail('READ_FAILED', 'Work memory read exceeded its total budget', ['snapshot']); };
  let run, memoryDir, scope;
  try {
    run = runDirFromEnv(env);
    scope = run.sessionGroup ?? '*';
    memoryDir = run.sessionGroup ? groupMemoryDir(run.sessionGroup, env) : path.join(zylosRoot(env), 'memory');
  } catch (cause) { throw fail('SCOPE_INVALID', cause.message); }
  try {
    parseStateHeader ??= (await import(pathToFileURL(path.join(zylosRoot(env), '.claude', 'skills', 'zylos-memory', 'scripts', 'state-format.js')).href)).parseStateHeader;
  } catch (cause) { throw fail('READ_FAILED', `Memory reader dependency unavailable: ${cause.message}`, ['dependencies']); }
  checkBudget();
  const waitMs = Math.min(8000, deadline - now() - 2000);
  if (waitMs < 0) throw fail('LOCK_TIMEOUT', 'Insufficient budget to wait for memory lock');
  let captured;
  try {
    captured = await withMemoryLock(run.dir, () => {
      const read = (file, part, optional = false) => {
        checkBudget();
        try { return Buffer.from(readFile(file)); }
        catch (cause) {
          if (optional && cause.code === 'ENOENT') return Buffer.alloc(0);
          throw fail('READ_FAILED', `Cannot read ${part}: ${cause.message}`, [part]);
        }
      };
      const state = read(path.join(memoryDir, 'state.md'), 'state', true);
      let header;
      try { header = state.length ? parseStateHeader(decode(state), { scope }) : { valid: false }; }
      catch (cause) { throw fail('READ_FAILED', `Cannot parse state: ${cause.message}`, ['state']); }
      if (!header.valid) header = { valid: false, scope: null, coverage: null, inboxCommitted: [] };
      const inbox = read(path.join(memoryDir, 'inbox.md'), 'inbox', true);
      let names;
      try { names = listFiles(memoryDir); }
      catch (cause) {
        if (cause.code === 'ENOENT') names = [];
        else throw fail('READ_FAILED', `Cannot list segments: ${cause.message}`, ['segments']);
      }
      const committed = new Set(header.inboxCommitted);
      const segments = names.map(name => ({ name, id: segmentName.exec(name)?.[1] }))
        .filter(item => item.id && !committed.has(item.id))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        .map(({ name, id }) => ({ id, bytes: read(path.join(memoryDir, name), `segment:${id}`) }));
      checkBudget();
      return { state, header, inbox, segments };
    }, { waitMs });
  } catch (cause) {
    if (cause.code === 'LOCK_TIMEOUT') throw fail('LOCK_TIMEOUT', cause.message);
    if (cause.code === 'READ_FAILED') throw cause;
    throw fail('READ_FAILED', `Memory snapshot failed: ${cause.message}`, ['snapshot']);
  }
  checkBudget();
  let text;
  try {
    text = [`# Working Memory (${scope})`, '## state.md', decode(captured.state),
      '## inbox.md', decode(captured.inbox), ...captured.segments.flatMap(segment =>
        [`## inbox.${segment.id}.md`, decode(segment.bytes)])].join('\n\n') + '\n';
  } catch (cause) { throw fail('READ_FAILED', `Work memory is not UTF-8: ${cause.message}`, ['snapshot']); }
  const warnings = captured.header.valid ? [] : ['State header is invalid; all existing segments are included.'];
  const data = { scope, state: { ...captured.header, ...metadata(captured.state) },
    inbox: metadata(captured.inbox), segments: captured.segments.map(segment => ({ id: segment.id, ...metadata(segment.bytes) })), warnings, text };
  const output = json ? JSON.stringify({ ok: true, data }) + '\n' :
    `OK: working memory\n${JSON.stringify({ ...data, text: undefined })}\n${text}`;
  checkBudget();
  if (Buffer.byteLength(output) <= OUTPUT_LIMIT) return { data, output };
  const bytes = Buffer.from(output);
  // The spill is the already captured result, never a second read of sources.
  const runId = String(env.ZYLOS_RUN_ID || 'legacy').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  const file = path.join(temporaryDir, `zylos-work-memory-${runId}-${now()}-${randomUUID()}.md`);
  try { writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (cause) { throw fail('READ_FAILED', `Cannot write snapshot spill: ${cause.message}`, ['spill']); }
  checkBudget();
  const spilled = { scope, spill: { path: file, ...metadata(bytes) }, warnings };
  return { data: spilled, output: json ? JSON.stringify({ ok: true, data: spilled }) + '\n' :
    `OK: working memory spill\n${JSON.stringify(spilled)}\n` };
}

export async function runReadWorkMemoryCli(argv = process.argv.slice(2), options = {}) {
  const json = argv.includes('--json');
  try {
    const parsed = parseReadWorkMemoryArgs(argv);
    const result = await readWorkMemory({ ...options, ...parsed });
    process.stdout.write(result.output);
    return 0;
  } catch (cause) {
    const error = { code: cause.code || 'READ_FAILED', message: cause.message, persisted: [], ...(cause.parts ? { parts: cause.parts } : {}) };
    if (json) process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
    else process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
    return error.code === 'LOCK_TIMEOUT' ? 2 : 1;
  }
}
