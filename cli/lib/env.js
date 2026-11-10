/**
 * .env file read/write utilities
 *
 * Append-only writes: never overwrites existing keys.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { ENV_FILE } from './config.js';
import { checkPrivateFile, writePrivateFile } from './private-file.js';

/**
 * Make sure group and other users cannot access a .env file.
 * A file owned by the current user is tightened to 0600 on the spot; a file
 * owned by someone else is only reported. Missing or unreadable files, and
 * platforms without POSIX permission bits, are not checked.
 *
 * @param {string} [file]
 * @returns {{ok: boolean, mode: string|null, fixed: boolean}}
 */
export function ensureEnvFilePrivate(file = ENV_FILE, options = {}) {
  return checkPrivateFile(file, options);
}

/**
 * Write a .env file, creating it owner-only and tightening an existing one.
 *
 * @param {string} file
 * @param {string} content
 */
export function writeEnvFile(file, content) {
  writePrivateFile(file, content);
}

/**
 * Parse the .env file into a Map of key → value.
 * Ignores comments and blank lines.
 *
 * @returns {Map<string, string>}
 */
export function readEnvFile() {
  const env = new Map();
  if (!fs.existsSync(ENV_FILE)) return env;

  const content = fs.readFileSync(ENV_FILE, 'utf8');
  return new Map(Object.entries(parseDotenv(content)));
}

/**
 * Append environment entries to .env file.
 * Skips keys that already exist (append-only, never overwrites).
 *
 * @param {Map<string, string> | Record<string, string>} entries - Key-value pairs to write
 * @param {string} componentName - Used as section comment header
 * @returns {{ written: string[], skipped: string[] }}
 */
export function writeEnvEntries(entries, componentName) {
  const existing = readEnvFile();
  const written = [];
  const skipped = [];

  const pairs = entries instanceof Map ? entries : new Map(Object.entries(entries));

  const lines = [];
  for (const [key, value] of pairs) {
    if (existing.has(key)) {
      skipped.push(key);
      continue;
    }
    // Strip any embedded \r\n characters from value
    const cleanValue = value.replace(/[\r\n]/g, '').trim();
    // Quote values that contain spaces or special characters
    const needsQuote = /[\s#"'$`\\]/.test(cleanValue);
    const escaped = cleanValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
    lines.push(`${key}=${needsQuote ? `"${escaped}"` : cleanValue}`);
    written.push(key);
  }

  if (lines.length === 0) return { written, skipped };

  // Build block to append
  let block = '\n';
  block += `# ${componentName}\n`;
  block += lines.join('\n') + '\n';

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });

  writePrivateFile(ENV_FILE, block, { flag: 'a' });

  return { written, skipped };
}
