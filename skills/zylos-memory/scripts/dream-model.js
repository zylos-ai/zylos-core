import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCoreModule } from '../../activity-monitor/scripts/core-modules.js';
import { removeOwnedTree } from '../../comm-bridge/scripts/remove-owned-tree.js';

const TIMEOUTS = { stage1: 10 * 60_000, stage2: 30 * 60_000, tidy: 60 * 60_000, condense: 20 * 60_000, repair: 10 * 60_000 };
const OUTPUT_LIMIT = 64 * 1024 * 1024;

export async function createDreamModel(root, config) {
  const { DEFAULT_RUNTIME, getRuntime } = await loadCoreModule('runtime/index.js');
  const { launchEnvironment } = await loadCoreModule('runtime/session-command.js');
  const { dreamSettings } = await loadCoreModule('dream-settings.js');
  const runtime = await getRuntime(config.runtime ?? DEFAULT_RUNTIME);
  const { model, effort } = dreamSettings(config, runtime);
  const env = launchEnvironment(root, process.env, { runtimeEnv: runtime.launch.env });
  const command = runtime.identity.findExecutable(env);
  if (!command) throw new Error('Configured runtime executable is unavailable');

  return async ({ stage, instructions, input, tools = false, page, schema, signal, reportToolStats }) => {
    signal?.throwIfAborted();
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const cwd = fs.mkdtempSync(path.join(temporaryRoot, 'zylos-dream-'));
    const toolStats = tools && path.join(cwd, 'tool-result-bytes');
    try {
      const prepared = runtime.dream.prepare({
        instructions, input, tools, cwd, schema, root, env, model, effort,
        server: fileURLToPath(new URL('./memory-mcp-server.js', import.meta.url)),
        serverEnv: {
          ZYLOS_MEMORY_DREAM_ROOT: root,
          ...(page ? { ZYLOS_MEMORY_DREAM_PAGE: page } : {}),
          ...(toolStats ? { ZYLOS_MEMORY_DREAM_TOOL_STATS: toolStats } : {}),
        },
      });
      const stdout = await runModel(command, prepared, cwd, TIMEOUTS[stage], signal);
      if (prepared.answer) return fs.readFileSync(prepared.answer, 'utf8');
      const decode = runtime.dream.decodeOutput;
      return typeof decode === 'function' ? decode(stdout) : stdout;
    } finally {
      if (toolStats && reportToolStats) {
        try { reportToolStats(await readToolStats(toolStats)); }
        catch (error) { console.error(`Dream tool stats unavailable: ${error.code ?? error.message}`); }
      }
      removeOwnedTree(temporaryRoot, cwd);
    }
  };
}

async function readToolStats(file) {
  const metrics = { toolCalls: 0, toolResultBytes: 0, maxToolResultBytes: 0 };
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return metrics;
    throw error;
  }
  try {
    for await (const line of handle.readLines({ autoClose: false })) {
      const bytes = Number(line);
      metrics.toolCalls++;
      metrics.toolResultBytes += bytes;
      metrics.maxToolResultBytes = Math.max(metrics.maxToolResultBytes, bytes);
    }
  } finally {
    await handle.close();
  }
  return metrics;
}

function runModel(command, { args, env, stdin }, cwd, timeout, signal) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, { env, cwd, detached, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
    let text = '', bytes = 0, failure;
    function abort(error) {
      failure ??= error;
      if (!child.pid) return;
      try { if (detached) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') failure = error; }
    }
    const onAbort = () => abort(signal.reason);
    const deadline = setTimeout(() => abort(new Error('Dream model call timed out')), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > OUTPUT_LIMIT) abort(new Error('Dream model exceeded the output size limit'));
      else text += chunk;
    });
    child.on('error', error => { failure ??= error; });
    child.stdin?.on('error', error => { if (error.code !== 'EPIPE') abort(error); });
    child.stdin?.end(stdin);
    child.on('close', (code, terminationSignal) => {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Dream model exited with ${terminationSignal ?? code}`));
      else resolve(text);
    });
  });
}
