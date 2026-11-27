#!/usr/bin/env node
import path from 'node:path';
import { isMainModule } from './is-main-module.js';
import { createInterface } from 'node:readline';
import { memoryError } from './sync-cli.js';
import { resolveAllowedMemoryPath, applyFragmentLocked, isSelfPath } from './self-write.js';
import { dreamLock } from './dream-lock.js';
import { DREAM_READ_TOOLS, readDreamTool } from './dream-read-tools.js';
import { PAGE_FILENAME_GUIDANCE, pagePath } from './reference-index.js';

const codes = new Set(['PATH_NOT_ALLOWED', 'TOKEN_MISMATCH', 'FRAGMENT_CONFLICT', 'EXISTS', 'INVALID_INPUT', 'LOCK_TIMEOUT', 'WRITE_FAILED', 'LOCK_UNAVAILABLE', 'LEGACY_READ_ONLY']);
export const EDIT_MEMORY_TOOL = {
  name: 'edit_memory',
  description: 'Create or edit an authorized memory fragment. Every call must include the token from the dream instructions.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['op', 'path', 'replacement', 'token'],
    properties: { op: { type: 'string', enum: ['edit', 'create'] }, path: { type: 'string' },
      expected: { type: 'string' }, replacement: { type: 'string' }, token: { type: 'string' } },
  },
};

/** Bind once to the server's environment; requests cannot supply an identity. */
export function createMemoryEditor(env = process.env, { fragment = applyFragmentLocked } = {}) {
  const binding = Object.freeze({ ...env });
  const dreamRoot = binding.ZYLOS_MEMORY_DREAM_ROOT;
  const repairPage = dreamRoot && binding.ZYLOS_MEMORY_DREAM_PAGE;
  const checkRepair = repairPage ? (old, next) => {
    const body = text => {
      const boundary = /\r?\n[^\S\r\n]*\r?\n/.exec(text);
      return boundary ? text.slice(boundary.index) : '';
    };
    if (old === null || body(old) !== body(next)) throw memoryError('PATH_NOT_ALLOWED', 'A header repair may only edit the page header');
  } : undefined;
  return async input => {
    try {
      if (!input || Array.isArray(input) || typeof input !== 'object' ||
          Object.keys(input).some(key => !['op', 'path', 'expected', 'replacement', 'token'].includes(key)) ||
          !['create', 'edit'].includes(input.op) || typeof input.path !== 'string' ||
          typeof input.replacement !== 'string' ||
          ((input.op === 'edit' || Object.hasOwn(input, 'expected')) && typeof input.expected !== 'string')) {
        throw memoryError('INVALID_INPUT', 'Expected an edit or create memory operation');
      }
      if (!dreamRoot || typeof input.token !== 'string' || !/^[a-f0-9]{32}$/.test(input.token)) {
        throw memoryError('TOKEN_MISMATCH', 'A valid dream token is required');
      }
      return await dreamLock(dreamRoot).guard(input.token, () => {
        if (repairPage && (input.path !== repairPage || input.op !== 'edit')) {
          throw memoryError('PATH_NOT_ALLOWED', 'A header repair may only edit the designated page');
        }
        const legacy = relative => {
          const lower = relative.toLowerCase();
          return ['reference/projects.md', 'reference/decisions.md'].includes(lower) ||
            lower === 'reference/legacy' || lower.startsWith('reference/legacy/');
        };
        const resolved = resolveAllowedMemoryPath({ root: dreamRoot, path: input.path, allowed: candidate => {
          if (legacy(candidate)) throw memoryError('LEGACY_READ_ONLY', 'Legacy memory paths are read-only');
          if (!isSelfPath(candidate)) return false;
          if (input.op === 'create' && /^reference\/(projects|decisions)\//.test(candidate) &&
              !pagePath(candidate) && !pagePath(candidate, true)) {
            throw memoryError('PATH_NOT_ALLOWED', PAGE_FILENAME_GUIDANCE);
          }
          return true;
        } });
        const result = fragment({ target: resolved.target, expected: input.op === 'create' ? null : input.expected,
          replacement: input.replacement, ...(checkRepair ? { validate: checkRepair } : {}) });
        return { ok: true, path: resolved.path, bytes: result.bytes };
      });
    } catch (error) {
      if (!codes.has(error.code)) throw error;
      return { ok: false, code: error.code, message: error.message };
    }
  };
}

// Small stdio-only MCP endpoint. No user MCP or runtime configuration is written.
export async function serveMemoryTools({ input = process.stdin, output = process.stdout, env = process.env, editor = createMemoryEditor(env) } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let initialized = false;
  const dreamRoot = env.ZYLOS_MEMORY_DREAM_ROOT;
  const tools = dreamRoot ? [
    EDIT_MEMORY_TOOL,
    ...DREAM_READ_TOOLS.filter(tool => !env.ZYLOS_MEMORY_DREAM_PAGE || tool.name === 'read_memory'),
  ] : [];
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  async function dispatch(request) {
    if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return rpcError(request?.id ?? null, -32600, 'Invalid request');
    }
    if (!Object.hasOwn(request, 'id')) return null;
    const reply = result => ({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'initialize') {
      initialized = true;
      const requested = request.params?.protocolVersion;
      return reply({ protocolVersion: ['2024-11-05', '2025-03-26'].includes(requested) ? requested : '2025-03-26',
        capabilities: { tools: {} }, serverInfo: { name: 'zylos-memory', version: '1.0.0' } });
    }
    if (request.method === 'ping') return reply({});
    if (!initialized) return rpcError(request.id, -32000, 'Initialize first');
    if (request.method === 'tools/list') return reply({ tools });
    if (request.method === 'tools/call') {
      const { name, arguments: args } = request.params ?? {};
      if (!tools.some(tool => tool.name === name)) return rpcError(request.id, -32602, 'Unknown tool');
      try {
        if (name !== 'edit_memory') {
          if (env.ZYLOS_MEMORY_DREAM_PAGE && args?.path !== env.ZYLOS_MEMORY_DREAM_PAGE) {
            return rpcError(request.id, -32602, 'A header repair may only read the designated page');
          }
          return reply({ content: [{ type: 'text', text: readDreamTool(dreamRoot, name, args) }] });
        }
        const result = await editor(args);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok });
      } catch (error) {
        return rpcError(request.id, -32603, error.message);
      }
    }
    return rpcError(request.id, -32601, 'Method not found');
  }
  for await (const line of lines) {
    let message;
    try { message = JSON.parse(line); }
    catch { output.write(JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n'); continue; }
    let response;
    if (Array.isArray(message)) {
      response = message.length ? (await Promise.all(message.map(dispatch))).filter(Boolean) : rpcError(null, -32600, 'Empty batch');
      if (Array.isArray(response) && response.length === 0) continue;
    } else response = await dispatch(message);
    if (response) output.write(JSON.stringify(response) + '\n');
  }
}

if (isMainModule(import.meta.url)) {
  await serveMemoryTools();
}
