#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { memoryScope, readCurrentRunId, readMarker, withMemoryLock, memoryError } from './sync-lock.js';
import { resolveAllowedMemoryPath, applyFragmentLocked, isSelfPath } from './self-write.js';

const codes = new Set(['PATH_NOT_ALLOWED', 'TOKEN_MISMATCH', 'FRAGMENT_CONFLICT', 'EXISTS', 'INVALID_INPUT', 'LOCK_TIMEOUT', 'SCOPE_UNBOUND']);
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
export function createMemoryEditor(env = process.env, { currentRunId = readCurrentRunId, lock = withMemoryLock,
  fragment = applyFragmentLocked } = {}) {
  const binding = Object.freeze({ ...env });
  return async input => {
    try {
      if (!input || Array.isArray(input) || typeof input !== 'object' ||
          Object.keys(input).some(key => !['op', 'path', 'expected', 'replacement', 'token'].includes(key)) ||
          !['create', 'edit'].includes(input.op) || typeof input.path !== 'string' ||
          typeof input.replacement !== 'string' || (input.op === 'edit' && typeof input.expected !== 'string') ||
          (Object.hasOwn(input, 'expected') && typeof input.expected !== 'string')) {
        throw memoryError('INVALID_INPUT', 'Expected an edit or create memory operation');
      }
      if (!binding.ZYLOS_RUN_ID) throw memoryError('SCOPE_UNBOUND', 'The tool has no running session identity');
      let scope;
      try { scope = await memoryScope(binding); }
      catch { throw memoryError('SCOPE_UNBOUND', 'The tool has no valid session scope'); }
      if (!['group', 'single'].includes(scope.kind)) throw memoryError('SCOPE_UNBOUND', 'The tool has no bound session scope');
      if (typeof input.token !== 'string' || !/^[0-9a-f]{32}$/.test(input.token)) {
        throw memoryError('TOKEN_MISMATCH', 'A current Sync token is required');
      }
      return await lock(scope.runDir, async assertHeld => {
        const kinds = scope.kind === 'single' ? ['global'] : scope.sessionGroup === 'origin' ? ['group', 'origin'] : ['group'];
        const marker = kinds.map(kind => readMarker(scope.runDir, kind).marker)
          .find(candidate => candidate?.token === input.token && kinds.includes(candidate.kind));
        if (!marker || marker.runId !== scope.runId || await currentRunId(scope) !== scope.runId) {
          throw memoryError('TOKEN_MISMATCH', 'Sync ownership no longer matches this running session');
        }
        const temporary = marker.kind === 'group'
          ? `session-groups/${scope.sessionGroup}/state.md.${input.token}.tmp`
          : `state.md.${input.token}.tmp`;
        const allowed = relative => (marker.kind !== 'origin' && relative === temporary) ||
          (marker.kind !== 'group' && isSelfPath(relative));
        const resolved = resolveAllowedMemoryPath({ root: scope.root, path: input.path, allowed });
        const result = fragment({ target: resolved.target, expected: input.op === 'create' ? null : input.expected,
          replacement: input.replacement, assertHeld });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await serveMemoryTools();
}
