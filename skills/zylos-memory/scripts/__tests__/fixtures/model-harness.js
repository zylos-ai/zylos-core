// Fixture tool executor shared by the reference-index CLI tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EDIT_MEMORY_TOOL } from '../../memory-mcp-server.js';

const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const memoryScripts = path.join(repository, 'skills/zylos-memory/scripts');
const bridgeScripts = path.join(repository, 'skills/comm-bridge/scripts');
const scripts = Object.fromEntries(['sync-run', 'sync-lock', 'sync-files', 'origin-cursor', 'request-rotation', 'reference-index']
  .map(name => [name, path.join(memoryScripts, `${name}.js`)]));
Object.assign(scripts, Object.fromEntries(['c4-db', 'c4-fetch'].map(name => [name, path.join(bridgeScripts, `${name}.js`)])));

export const tools = [
  { name: 'read_file', description: 'Read a UTF-8 fixture file, relative to ZYLOS_DIR. Optional byte range [startByte,endByteExclusive) must end at UTF-8 boundaries; each read is at most 2 MiB. No writes.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, startByte: { type: 'integer', minimum: 0 }, endByteExclusive: { type: 'integer', minimum: 0 } } } },
  { name: 'list_files', description: 'List a fixture directory, relative to ZYLOS_DIR.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
  { name: 'run_script', description: 'Execute a real repository CLI with fixture-bound environment, argv and optional stdin. No shell. reference-index permits only rebuild, archive --path <page>, or unarchive --path <archived page>, without stdin or environment overrides.', inputSchema: { type: 'object', required: ['script', 'args'], properties: { script: { type: 'string', enum: Object.keys(scripts) }, args: { type: 'array', items: { type: 'string' } }, stdin: { type: 'string' } } } },
  EDIT_MEMORY_TOOL,
];

function fixturePath(f, input) {
  if (typeof input !== 'string') throw new Error('path must be a string');
  const target = path.resolve(f.root, input);
  const relative = path.relative(f.root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture path escaped isolated root');
  const resolved = fs.realpathSync(target);
  const root = fs.realpathSync(f.root);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Fixture symlink escaped isolated root');
  return target;
}
function fixtureOutputPath(f, input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new Error('Invalid fixture output path');
  const target = path.resolve(f.root, input);
  fixturePath(f, path.dirname(target));
  const relative = path.relative(f.root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture output path escaped isolated root');
  if (fs.existsSync(target) || fs.lstatSync(path.dirname(target)).isSymbolicLink()) throw new Error('Fixture output must be a new file in a real fixture directory');
  return target;
}
function cli(f, name, args, input = '') {
  const result = spawnSync(process.execPath, [scripts[name], ...args], { env: f.env, cwd: f.root, input, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', ...(result.error ? { error: result.error.message } : {}) };
}

function memoryClient(f) {
  const child = spawn(process.execPath, [path.join(memoryScripts, 'memory-mcp-server.js')], { env: f.env, cwd: f.root, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message);
  });
  const closed = new Promise(resolve => child.on('close', (code, signal) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`MCP exited ${code}/${signal}: ${stderr}`)); }
    pending.clear(); resolve();
  }));
  child.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP response timeout')); }, 25000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, request, close: async () => { child.stdin.end(); child.kill(); await closed; }, stderr: () => stderr };
}

export async function createToolExecutor(f) {
  const mcp = memoryClient(f);
  await mcp.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'model-workflow', version: '1' } });
  return {
    close: mcp.close,
    async execute(request) {
      const event = { sequence: f.trace.length + 1, at: new Date().toISOString(), request: structuredClone(request), effective: structuredClone(request.arguments || {}), before: f.snapshot() };
      const a = event.effective;
      let result;
      try {
        if (request.name === 'read_file') {
          const file = fixturePath(f, a.path), info = fs.statSync(file);
          const startByte = a.startByte ?? 0, endByteExclusive = a.endByteExclusive ?? info.size;
          if (![startByte, endByteExclusive].every(Number.isSafeInteger) || startByte < 0 || endByteExclusive < startByte || endByteExclusive > info.size) throw new Error('Invalid byte range');
          if (endByteExclusive - startByte > 2 * 1024 * 1024) throw new Error('File exceeds read limit; request byte ranges');
          const bytes = Buffer.alloc(endByteExclusive - startByte), descriptor = fs.openSync(file, 'r');
          try { assert.equal(fs.readSync(descriptor, bytes, 0, bytes.length, startByte), bytes.length); }
          finally { fs.closeSync(descriptor); }
          const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          result = { ok: true, path: a.path, content, startByte, endByteExclusive, bytes: info.size };
        } else if (request.name === 'list_files') result = { ok: true, entries: fs.readdirSync(fixturePath(f, a.path)).sort() };
        else if (request.name === 'edit_memory') {
          const rpc = await mcp.request('tools/call', { name: 'edit_memory', arguments: a });
          result = rpc.error ? { ok: false, code: 'TOOL_PROTOCOL_ERROR', rpc } : { ...JSON.parse(rpc.result.content[0].text), rpc };
        } else if (request.name === 'run_script') {
          if (a.script === 'reference-index') {
            const stringArgs = Array.isArray(a.args) && a.args.every(value => typeof value === 'string');
            const rebuild = stringArgs && a.args.length === 1 && a.args[0] === 'rebuild';
            const move = stringArgs && a.args.length === 3 && ['archive', 'unarchive'].includes(a.args[0]) &&
              a.args[1] === '--path' && a.args[2].length > 0 && !a.args[2].startsWith('--');
            if ((!rebuild && !move) || (a.stdin !== undefined && a.stdin !== '') ||
                Object.keys(a).some(key => !['script', 'args', 'stdin'].includes(key))) {
              throw new Error('reference-index expects rebuild, archive --path <page>, or unarchive --path <archived page>; no extra arguments, stdin, or environment overrides');
            }
          }
          if (!Object.hasOwn(scripts, a.script) || !Array.isArray(a.args) || a.args.some(value => typeof value !== 'string') || (a.stdin !== undefined && typeof a.stdin !== 'string')) throw new Error('Invalid script request');
          if (Object.keys(a).some(key => !['script', 'args', 'stdin'].includes(key))) throw new Error('Unexpected script request fields');
          // Exports use exclusive-create in the real CLI and stay inside the fixture.
          if (a.script === 'c4-db' && !['unsummarized', 'origin-sync'].includes(a.args[0])) throw new Error('c4-db command is outside Sync read surface');
          if (a.script === 'c4-fetch') {
            if (!['--unsummarized', '--checkpoints', '--origin-sync', '--absorbed', '--begin'].includes(a.args[0])) throw new Error('c4-fetch command is outside Sync read surface');
            const outputOptions = a.args.filter(value => value === '--out' || value.startsWith('--out='));
            if (outputOptions.length) {
              if (outputOptions.length !== 1 || outputOptions[0] !== '--out' || !['--unsummarized', '--absorbed'].includes(a.args[0])) throw new Error('Invalid fixture export option');
              const index = a.args.indexOf('--out');
              a.args[index + 1] = fixtureOutputPath(f, a.args[index + 1]);
            }
          }
          result = cli(f, a.script, a.args, a.stdin);
        } else throw new Error(`Unknown tool: ${request.name}`);
      } catch (error) { result = { ok: false, code: error.code || 'TOOL_PROTOCOL_ERROR', message: error.message }; }
      event.result = result; event.after = f.snapshot(); f.trace.push(event);
      return result;
    },
  };
}
