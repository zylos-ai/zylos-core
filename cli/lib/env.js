/**
 * .env file read/write utilities
 *
 * Append-only writes: never overwrites existing keys.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ENV_FILE } from './config.js';

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
 * Upsert environment entries in .env.
 * Unlike writeEnvEntries(), this updates existing keys in place.
 *
 * @param {Map<string, string> | Record<string, string>} entries
 * @param {{ comment?: string }} [opts]
 * @returns {{ written: string[], updated: string[] }}
 */
export function upsertEnvEntries(entries, opts = {}) {
  const pairs = entries instanceof Map ? entries : new Map(Object.entries(entries));
  const existingContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  let content = existingContent;
  const written = [];
  const updated = [];

  for (const [key, rawValue] of pairs) {
    const cleanValue = String(rawValue).replace(/[\r\n]/g, '').trim();
    const needsQuote = /[\s#"'$`\\]/.test(cleanValue);
    const escaped = cleanValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
    const line = `${key}=${needsQuote ? `"${escaped}"` : cleanValue}`;
    const rx = new RegExp(`^${key}=.*$`, 'm');
    if (rx.test(content)) {
      content = content.replace(rx, line);
      updated.push(key);
    } else {
      if (!content.endsWith('\n') && content.length) content += '\n';
      if (opts.comment && !content.includes(`# ${opts.comment}`)) {
        content += `\n# ${opts.comment}\n`;
      }
      content += `${line}\n`;
      written.push(key);
    }
  }

  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  fs.writeFileSync(ENV_FILE, content);
  return { written, updated };
}

/**
 * Normalize legacy env aliases to canonical keys.
 * Returns true if any change was applied.
 */
export function normalizeLegacyEnvAliases() {
  const env = readEnvFile();
  let changed = false;

  const aliases = [
    ['ZYLOS_WEB_PORT', 'WEB_CONSOLE_PORT'],
    ['WEB_CONSOLE_PASSWORD', 'ZYLOS_WEB_PASSWORD'],
  ];

  for (const [legacyKey, canonicalKey] of aliases) {
    if (env.has(legacyKey) && !env.has(canonicalKey)) {
      env.set(canonicalKey, env.get(legacyKey));
      changed = true;
    }
  }

  if (!changed) return false;
  upsertEnvEntries(Object.fromEntries(env), { comment: 'Normalized by zylos' });
  return true;
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

  fs.appendFileSync(ENV_FILE, block);

  return { written, skipped };
}
