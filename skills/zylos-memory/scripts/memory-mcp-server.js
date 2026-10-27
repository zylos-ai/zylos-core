#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { guard, memoryError } from './sync-lock.js';
import { resolveAllowedMemoryPath, applyFragmentLocked, isSelfPath } from './self-write.js';

const codes = new Set(['PATH_NOT_ALLOWED', 'TOKEN_MISMATCH', 'FRAGMENT_CONFLICT', 'EXISTS', 'INVALID_INPUT', 'LOCK_TIMEOUT', 'SCOPE_UNBOUND', 'WRITE_FAILED', 'LOCK_UNAVAILABLE']);
export const EDIT_MEMORY_TOOL = {
  name: 'edit_memory',
  description: 'Create or edit an authorized memory fragment using the current Sync token.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['op', 'path', 'replacement', 'token'],
    properties: { op: { type: 'string', enum: ['edit', 'create'] }, path: { type: 'string' },
      expected: { type: 'string' }, replacement: { type: 'string' }, token: { type: 'string' } },
  },
};

/** Bind once to the server's environment; requests cannot supply an identity. */
export function createMemoryEditor(env = process.env, { fragment = applyFragmentLocked } = {}) {
  const binding = Object.freeze({ ...env });
  return async input => {
    try {
      if (!input || Array.isArray(input) || typeof input !== 'object' ||
          Object.keys(input).some(key => !['op', 'path', 'expected', 'replacement', 'token'].includes(key)) ||
          !['create', 'edit'].includes(input.op) || typeof input.path !== 'string' ||
          typeof input.replacement !== 'string' ||
          ((input.op === 'edit' || Object.hasOwn(input, 'expected')) && typeof input.expected !== 'string')) {
        throw memoryError('INVALID_INPUT', 'Expected an edit or create memory operation');
      }
      return await guard({ kind: 'auto', token: input.token, env: binding }, scope => {
        const { marker } = scope;
        const temporary = path.relative(path.join(scope.root, 'memory'),
          path.join(scope.memoryDir, `state.md.${input.token}.tmp`)).split(path.sep).join('/');
        const allowed = relative => (marker.kind !== 'origin' && relative === temporary) ||
          (marker.kind !== 'group' && isSelfPath(relative));
        const resolved = resolveAllowedMemoryPath({ root: scope.root, path: input.path, allowed });
        const result = fragment({ target: resolved.target, expected: input.op === 'create' ? null : input.expected,
          replacement: input.replacement });
        return { ok: true, path: resolved.path, bytes: result.bytes };
      });
    } catch (error) {
      if (!codes.has(error.code)) throw error;
      return { ok: false, code: error.code, message: error.message };
    }
  };
}

// Small stdio-only MCP endpoint. No user MCP or runtime configuration is written.
export async function serveMemoryTools({ input = process.stdin, output = process.stdout, editor = createMemoryEditor() } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let initialized = false;
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
    if (request.method === 'tools/list') return reply({ tools: [EDIT_MEMORY_TOOL] });
    if (request.method === 'tools/call') {
      if (request.params?.name !== 'edit_memory') return rpcError(request.id, -32602, 'Unknown tool');
      try {
        const result = await editor(request.params.arguments);
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

function isMainModule() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMainModule()) {
  await serveMemoryTools();
}
