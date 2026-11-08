/**
 * .env file read/write utilities
 *
 * Append-only writes: never overwrites existing keys.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ENV_FILE } from './config.js';

// .env holds API keys, tokens and passwords; keep it readable by the owner only.
const ENV_FILE_MODE = 0o600;

/**
 * Restrict an existing .env file to owner read/write.
 * Best effort: a filesystem without POSIX modes keeps its own permissions.
 *
 * @param {string} file
 */
export function secureEnvFile(file) {
  try {
    fs.chmodSync(file, ENV_FILE_MODE);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EPERM' && err.code !== 'ENOTSUP') throw err;
  }
}

/**
 * Report whether a .env file is readable or writable by group or others.
 * Platforms without POSIX permission bits are not checked.
 *
 * @param {string} [file]
 * @returns {{ok: boolean, exists: boolean, mode: string|null, checked: boolean}}
 */
export function checkEnvFilePermissions(file = ENV_FILE, { platform = process.platform } = {}) {
  if (platform === 'win32') return { ok: true, exists: fs.existsSync(file), mode: null, checked: false };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, exists: false, mode: null, checked: true };
    throw err;
  }
  const bits = stat.mode & 0o777;
  return { ok: (bits & 0o077) === 0, exists: true, mode: bits.toString(8).padStart(3, '0'), checked: true };
}

/**
 * Write a .env file, creating it owner-only and tightening an existing one.
 *
 * @param {string} file
 * @param {string} content
 */
export function writeEnvFile(file, content) {
  fs.writeFileSync(file, content, { mode: ENV_FILE_MODE });
  secureEnvFile(file);
}

/**
 * Copy a template into place as an owner-only .env file.
 *
 * @param {string} source
 * @param {string} file
 */
export function copyEnvFile(source, file) {
  fs.copyFileSync(source, file);
  secureEnvFile(file);
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
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    // Strip surrounding quotes from value
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env.set(key, value);
  }
  return env;
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

  fs.appendFileSync(ENV_FILE, block, { mode: ENV_FILE_MODE });
  secureEnvFile(ENV_FILE);

  return { written, skipped };
}
