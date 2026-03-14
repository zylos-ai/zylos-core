/**
 * RuntimeRegistry — loads and returns the active runtime adapter.
 *
 * The active runtime is stored in ~/.zylos/config.json as { "runtime": "claude" }.
 * Defaults to "claude" when not set (backwards compatible).
 *
 * Usage:
 *   import { getActiveAdapter } from '../lib/runtime/index.js';
 *   const adapter = getActiveAdapter();
 *   await adapter.buildInstructionFile();
 *   await adapter.launch();
 */

import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { getZylosConfig } from '../config.js';

// ── Runtime registry ──────────────────────────────────────────────────────

/**
 * Map of runtime name → adapter class.
 * Add new runtimes here as they are implemented.
 */
const REGISTRY = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
};

/**
 * Supported runtime names.
 * @type {string[]}
 */
export const SUPPORTED_RUNTIMES = Object.keys(REGISTRY);

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Get the adapter class for a named runtime.
 *
 * @param {string} name - Runtime name (e.g. 'claude', 'codex')
 * @returns {typeof import('./base.js').RuntimeAdapter}
 * @throws {Error} if runtime is unknown
 */
export function getAdapterClass(name) {
  const Cls = REGISTRY[name];
  if (!Cls) {
    throw new Error(
      `Unknown runtime: '${name}'. Supported: ${SUPPORTED_RUNTIMES.join(', ')}`
    );
  }
  return Cls;
}

/**
 * Instantiate an adapter for a named runtime.
 *
 * @param {string} name
 * @param {object} [config] - Optional config override (defaults to reading config.json)
 * @returns {import('./base.js').RuntimeAdapter}
 */
export function getAdapter(name, config) {
  const Cls = getAdapterClass(name);
  return new Cls(config ?? getZylosConfig());
}

/**
 * Get an adapter instance for the currently configured runtime.
 * Reads 'runtime' from ~/.zylos/config.json; defaults to 'claude'.
 *
 * @param {object} [config] - Optional config override
 * @returns {import('./base.js').RuntimeAdapter}
 */
export function getActiveAdapter(config) {
  const cfg = config ?? getZylosConfig();
  const runtime = cfg.runtime ?? 'claude';
  return getAdapter(runtime, cfg);
}
