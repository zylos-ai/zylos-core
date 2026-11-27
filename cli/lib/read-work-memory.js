import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runDirFromEnv, groupMemoryDir, zylosRoot } from './session-group-paths.js';

const OUTPUT_LIMIT = 32 * 1024;
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

/** Read the retired state from this scope for its next handoff. */
export async function readWorkMemory({
  env = process.env, timeoutMs = 10000, json = true, now = Date.now,
  readFile = fs.readFileSync, writeFile = fs.writeFileSync, temporaryDir = env.TMPDIR || os.tmpdir(),
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 2000) throw fail('INVALID_ARGS', 'timeout-ms must be an integer greater than 2000');
  const deadline = now() + timeoutMs;
  const checkBudget = () => { if (now() >= deadline) throw fail('READ_FAILED', 'Work memory read exceeded its total budget', ['snapshot']); };
  let memoryDir, scope;
  try {
    const { sessionGroup } = runDirFromEnv(env);
    scope = sessionGroup ?? '*';
    memoryDir = sessionGroup ? groupMemoryDir(sessionGroup, env) : path.join(zylosRoot(env), 'memory');
  } catch (cause) { throw fail('SCOPE_INVALID', cause.message); }
  let state;
  try { state = Buffer.from(readFile(path.join(memoryDir, 'state.md'))); }
  catch (cause) {
    if (cause.code !== 'ENOENT') throw fail('READ_FAILED', `Cannot read state: ${cause.message}`, ['state']);
  }
  checkBudget();
  let body;
  try { body = state ? decode(state) : 'No historical state file for this scope.'; }
  catch (cause) { throw fail('READ_FAILED', `State is not UTF-8: ${cause.message}`, ['state']); }
  const text = `# Working Memory (${scope})\n\n## state.md (no longer updated)\n\n${body}\n`;
  const data = { scope, state: state ? { ...metadata(state), retired: true } : null, text };
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
  const spilled = { scope, spill: { path: file, ...metadata(bytes) } };
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
    return 1;
  }
}
