#!/usr/bin/env node
/**
 * Session Start Injection
 *
 * Reads core memory files and prints plain text sections for hook injection.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MEMORY_DIR } from './shared.js';
import { formatSection } from '../../comm-bridge/scripts/session-format.js';

let diagnosticModule;
let diagnosticLoadAttempted = false;

async function getDiagnosticModule() {
  if (!diagnosticLoadAttempted) {
    diagnosticLoadAttempted = true;
    try {
      diagnosticModule = await import('../../comm-bridge/scripts/c4-diagnostic.js');
    } catch {
      diagnosticModule = null;
    }
  }
  return diagnosticModule;
}

async function logHookTimingSafe(name, durationMs) {
  const module = await getDiagnosticModule();
  if (module?.logHookTiming) {
    module.logHookTiming(name, durationMs);
  }
}

function readFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, reason: 'missing' };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, reason: `read error: ${err.message}` };
  }
}

function section(label, filePath) {
  const result = readFileSafe(filePath);
  const content = result.ok ? (result.content || '') : `(${result.reason})`;
  return formatSection(label, content);
}

export const MEMORY_PARTS = Object.freeze({
  identity: Object.freeze({ label: 'BOT IDENTITY', file: 'identity.md' }),
  state: Object.freeze({ label: 'ACTIVE STATE', file: 'state.md' }),
  references: Object.freeze({ label: 'REFERENCES', file: 'references.md' }),
});

/**
 * Emit a single memory section. Used by the session-start shard orchestrator
 * so each memory file gets its own hook stdout budget instead of sharing one.
 */
export function emitMemoryPart(part) {
  const spec = MEMORY_PARTS[part];
  if (!spec) throw new Error(`unknown memory part "${part}"`);
  return section(spec.label, path.join(MEMORY_DIR, spec.file));
}

export function injectMemory() {
  const parts = [
    emitMemoryPart('identity'),
    emitMemoryPart('state'),
    emitMemoryPart('references')
  ];

  return `${parts.join('\n\n')}\n`;
}

async function runCli() {
  const startMs = Date.now();
  try {
    process.stdout.write(injectMemory());
  } catch (err) {
    console.error(`session-start-inject error: ${err.message}`);
  } finally {
    await logHookTimingSafe('session-start-inject', Date.now() - startMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    // Best-effort.
  });
}
