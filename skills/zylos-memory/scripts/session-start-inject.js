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

/**
 * #686: sections are emitted in priority order so that when the runtime
 * truncates hook output to a short preview, the preview carries the
 * highest-value content first. Identity and references lead; state (the
 * largest, most volatile file) trails the C4 context, which the
 * orchestrator injects between the two halves.
 */
export function injectMemoryCore() {
  const parts = [
    section('BOT IDENTITY', path.join(MEMORY_DIR, 'identity.md')),
    section('REFERENCES', path.join(MEMORY_DIR, 'references.md'))
  ];

  return `${parts.join('\n\n')}\n`;
}

export function injectMemoryState() {
  return `${section('ACTIVE STATE', path.join(MEMORY_DIR, 'state.md'))}\n`;
}

export function injectMemory() {
  const parts = [
    section('BOT IDENTITY', path.join(MEMORY_DIR, 'identity.md')),
    section('REFERENCES', path.join(MEMORY_DIR, 'references.md')),
    section('ACTIVE STATE', path.join(MEMORY_DIR, 'state.md'))
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
