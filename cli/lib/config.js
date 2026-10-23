/**
 * Shared configuration constants and helpers
 */

import fs from 'node:fs';
import path from 'node:path';
import { configUnreadable, readConfigStrict } from './config-store.js';
import { updateConfigWithLock } from './config-lock.js';

export const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
export const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');
export const CONFIG_DIR = path.join(ZYLOS_DIR, '.zylos');
export const COMPONENTS_DIR = path.join(ZYLOS_DIR, 'components');
export const LOCKS_DIR = path.join(CONFIG_DIR, 'locks');
export const REGISTRY_FILE = path.join(CONFIG_DIR, 'registry.json');
export const COMPONENTS_FILE = path.join(CONFIG_DIR, 'components.json');
export const BIN_DIR = path.join(ZYLOS_DIR, 'bin');
export const ENV_FILE = path.join(ZYLOS_DIR, '.env');
export const HTTP_DIR = path.join(ZYLOS_DIR, 'http');
export const CADDYFILE = path.join(HTTP_DIR, 'Caddyfile');
export const CADDY_BIN = path.join(BIN_DIR, 'caddy');

// ── Config file (config.json) ───────────────────────────────────

export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Read the zylos config.json.
 * @returns {object} Config object (empty object if file doesn't exist)
 */
export function getZylosConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Strictly read config.json without turning corruption or I/O failures into
 * missing configuration.
 */
export function readZylosConfigStrict() {
  return readConfigStrict(CONFIG_FILE);
}

export function readSessionMode() {
  const result = readZylosConfigStrict();
  if (result.state === 'error') throw configUnreadable(result.error);
  if (result.state === 'missing' || !Object.hasOwn(result.config, 'session_mode')) {
    return { mode: null, keyPresent: false };
  }
  const mode = result.config.session_mode;
  if (mode !== 'single' && mode !== 'multi') {
    throw configUnreadable(new TypeError('session_mode must be "single" or "multi"'));
  }
  return { mode, keyPresent: true };
}

export function updateZylosConfigLocked(update, options = {}) {
  return updateConfigWithLock({
    configFile: CONFIG_FILE,
    lockFile: `${CONFIG_FILE}.lock`,
    update,
    ...options,
  });
}

export function writeSessionModeAtCutover(mode, options = {}) {
  if (mode !== 'single' && mode !== 'multi') {
    throw new TypeError('session mode must be "single" or "multi"');
  }
  let writeResult;
  try {
    writeResult = updateZylosConfigLocked({ set: { session_mode: mode } }, options);
  } catch (error) {
    if (error.code !== 'CONFIG_WRITE_FAILED' || error.phase !== 'after_rename') throw error;
    try { error.verification = readSessionMode(); } catch (verifyError) { error.verificationError = verifyError; }
    throw error;
  }
  const verification = readSessionMode();
  if (!verification.keyPresent || verification.mode !== mode) {
    throw configUnreadable(new Error(`session_mode verification mismatch: expected ${mode}`));
  }
  return { ...writeResult, verification };
}
