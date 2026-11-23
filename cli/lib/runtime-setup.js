/**
 * runtime-setup.js — shared runtime setup utilities.
 */

import { execFileSync } from 'node:child_process';
import { parse as parseDotEnv } from 'dotenv';
import { checkPrivateFile } from './private-file.js';

export function upsertEnvValue(content, key, value, comment = null) {
  const line = `${key}=${value}`;
  if (content.match(new RegExp(`^${key}=.*$`, 'm'))) {
    return content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  const prefix = comment ? `\n\n# ${comment}\n` : '\n';
  return content.trimEnd() + `${prefix}${line}\n`;
}

export function credentialEnvValue(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) return null;
  // Preserve the exact credential without adding escape bytes. Use only a
  // lossless dotenv representation and reject unrepresentable input before writing.
  for (const candidate of [value, `'${value}'`, `"${value}"`]) {
    const literal = candidate.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (literal === value && parseDotEnv(`CREDENTIAL=${candidate}\n`).CREDENTIAL === value) return candidate;
  }
  return null;
}

export function isValidBaseUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.host
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

// ── Install ────────────────────────────────────────────────────────────────

/**
 * Install an npm global package.
 * @param {string} pkg - Package name (e.g. "@openai/codex")
 * @returns {boolean}
 */
export function installGlobalPackage(pkg) {
  try {
    execFileSync('npm', ['install', '-g', pkg], { stdio: 'pipe', timeout: 120000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep credential files owner-only and describe the ones that could not be
 * restricted (foreign-owned or read-only). Never throws.
 *
 * @param {string[]} files
 * @returns {string[]} one message per file other users can still read
 */
export function credentialFilePermissionWarnings(files) {
  const warnings = [];
  for (const file of files) {
    const result = checkPrivateFile(file);
    if (!result.ok) {
      warnings.push(`${file} holds credentials but is mode ${result.mode} and could not be restricted; run: chmod 600 ${file}`);
    }
  }
  return warnings;
}

export function warnUnrestrictedCredentialFiles(files, warnings) {
  for (const message of credentialFilePermissionWarnings(files)) {
    warnings.push({ code: 'CREDENTIAL_FILE_NOT_PRIVATE', message });
  }
}
