#!/usr/bin/env node
/**
 * Session Start Injection
 *
 * Reads core memory files and prints plain text sections for hook injection.
 */

import fs from 'fs';
import path from 'path';
import { MEMORY_DIR } from './shared.js';

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
  const lines = [`=== ${label} ===`];

  if (result.ok) {
    const text = (result.content || '').trim();
    lines.push(text.length > 0 ? text : '(empty)');
  } else {
    lines.push(`(${result.reason})`);
  }

  return lines.join('\n');
}

function main() {
  const parts = [
    section('BOT IDENTITY', path.join(MEMORY_DIR, 'identity.md')),
    section('ACTIVE STATE', path.join(MEMORY_DIR, 'state.md')),
    section('REFERENCES', path.join(MEMORY_DIR, 'references.md'))
  ];

  process.stdout.write(`${parts.join('\n\n')}\n`);
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
