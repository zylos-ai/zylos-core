/**
 * Shared configuration constants and helpers
 */

import fs from 'node:fs';
import path from 'node:path';

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

// Built-in runtime passthrough: Zylos Core carries these from ~/zylos/.env into
// that runtime's sessions and auth probe without a runtime-env.manifest line.
// The manifest only filters other variables and cannot drop these. Each
// runtime gets only its own variables.
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is a setting, not a credential.
// Codex ignores both of its variables today (measured with codex-cli 0.166.0):
// OPENAI_API_KEY is never sent as a credential by `codex exec`, the interactive
// session or `codex login status`; it only pre-fills the API-key option on the
// interactive sign-in screen when ~/.codex/auth.json is missing. OPENAI_BASE_URL
// is ignored without a warning; only openai_base_url in ~/.codex/config.toml
// changes the endpoint. They are carried for consistency.
export const RUNTIME_BUILTIN_ENV_KEYS = Object.freeze({
  claude: Object.freeze([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  ]),
  codex: Object.freeze(['OPENAI_BASE_URL', 'OPENAI_API_KEY']),
});

// ── Config file (config.json) ───────────────────────────────────

const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

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
 * Write the zylos config.json (merges with existing).
 * @param {object} updates - Key-value pairs to merge into config
 */
export function updateZylosConfig(updates) {
  const config = getZylosConfig();
  Object.assign(config, updates);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}
