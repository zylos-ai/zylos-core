/**
 * Session-start shard registry.
 *
 * Single source of truth for the session-start injection chain: which shards
 * exist, their chain order, their emitters, and their per-shard output
 * budgets. Consumed by:
 * - session-start-orchestrator.js --shard <name> (runtime emission)
 * - cli/lib/sync-settings-hooks.js (Claude settings hook generation)
 * - cli/lib/codex-hooks.js (Codex hooks.json generation)
 *
 * Core shards occupy chain orders 1-5. Components join the chain via opt-in
 * declaration files in ~/zylos/.zylos/shards.d/<name>.json:
 *
 *   {
 *     "name": "role-inject",            // unique shard name, [a-z0-9_-]
 *     "order": 10,                      // chain slot, components use 10+
 *     "emitter": "skills/role-manager/emit-role.js",  // under ~/zylos/.claude
 *     "budget": { "maxChars": 10000, "maxTokens": 2200 },  // optional
 *     "claimHooks": ["skills/role-manager/role-inject-hook.sh"]  // optional
 *   }
 *
 * `claimHooks` lists the component's OWN legacy SessionStart hook paths
 * (relative to ~/zylos/.claude) that hook sync may remove once the shard
 * command replaces them. Sync only ever consumes these declarations — it
 * never guesses paths and never claims hooks that no declaration names, so
 * user hooks and undeclared component hooks are untouched. Undeclared
 * component hooks keep running outside the chain, unordered, exactly as
 * before the shard split.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Per-shard output budget. Dual limit:
 * - maxChars: Claude Code persists hook stdout above 10,000 characters,
 *   leaving only a ~2KB preview in context.
 * - maxTokens: Codex elides hook output above its per-hook token cap
 *   (keeps exactly 2,469 tokens on codex-cli 0.142.0, measured across
 *   ASCII/CJK/mixed inputs); 2,200 leaves headroom. Estimated with the
 *   ascii/4 + non-ascii/1.3 heuristic: 11,000 lorem chars measured as
 *   2,750 tokens (4.0 chars/token) and 8,000 CJK chars as 5,970 tokens
 *   (~1.34 chars/token), so 1.3 keeps the estimate on the safe side of
 *   common CJK. Re-verify against the cap when codex-cli upgrades.
 */
export const DEFAULT_SHARD_BUDGET = Object.freeze({ maxChars: 10_000, maxTokens: 2_200 });
export const COMPONENT_ORDER_MIN = 10;

const SHARD_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const SIDE_EFFECT_NAMES = Object.freeze({
  foreground: 'fg',
  startPrompt: 'start-prompt',
});

export const CORE_SHARDS = Object.freeze([
  {
    name: 'identity',
    order: 1,
    emit: async payload =>
      (await import('../../zylos-memory/scripts/session-start-inject.js')).emitMemoryPart('identity', payload),
  },
  {
    name: 'references',
    order: 2,
    emit: async payload =>
      (await import('../../zylos-memory/scripts/session-start-inject.js')).emitMemoryPart('references', payload),
  },
  {
    name: 'state',
    order: 3,
    emit: async payload =>
      (await import('../../zylos-memory/scripts/session-start-inject.js')).emitMemoryPart('state', payload),
  },
  {
    name: 'c4-checkpoint',
    order: 4,
    emit: async payload =>
      (await import('../../comm-bridge/scripts/c4-session-init.js')).emitC4Checkpoint(payload),
  },
  {
    name: 'c4-conversations',
    order: 5,
    emit: async payload =>
      (await import('../../comm-bridge/scripts/c4-session-init.js')).emitC4Conversations(payload),
  },
].map(Object.freeze));

const RESERVED_NAMES = new Set([
  ...CORE_SHARDS.map(shard => shard.name),
  SIDE_EFFECT_NAMES.foreground,
  SIDE_EFFECT_NAMES.startPrompt,
]);

export function defaultZylosDir(env = process.env) {
  return path.resolve(env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
}

export function shardsDeclarationDir(zylosDir = defaultZylosDir()) {
  return path.join(zylosDir, '.zylos', 'shards.d');
}

function normalizedClaudeRoot(zylosDir) {
  return `${path.resolve(zylosDir, '.claude').replaceAll('\\', '/').replace(/\/+$/, '')}/`;
}

function isRelativeClaimPath(claim) {
  if (typeof claim !== 'string' || !claim.trim()) return false;
  if (claim.startsWith('/') || claim.startsWith('~') || /^[A-Za-z]:/.test(claim)) return false;
  return !claim.split('/').includes('..');
}

function validateBudget(budget) {
  if (budget == null) return { ...DEFAULT_SHARD_BUDGET };
  if (typeof budget !== 'object') return null;
  const maxChars = budget.maxChars == null ? DEFAULT_SHARD_BUDGET.maxChars : Number(budget.maxChars);
  const maxTokens = budget.maxTokens == null ? DEFAULT_SHARD_BUDGET.maxTokens : Number(budget.maxTokens);
  if (!Number.isFinite(maxChars) || !Number.isFinite(maxTokens) || maxChars <= 0 || maxTokens <= 0) {
    return null;
  }
  return {
    maxChars: Math.min(Math.floor(maxChars), DEFAULT_SHARD_BUDGET.maxChars),
    maxTokens: Math.min(Math.floor(maxTokens), DEFAULT_SHARD_BUDGET.maxTokens),
  };
}

function validateDeclaration(raw, { zylosDir, takenNames }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'declaration must be a JSON object' };
  }
  const name = raw.name;
  if (typeof name !== 'string' || !SHARD_NAME_RE.test(name)) {
    return { error: `invalid shard name ${JSON.stringify(raw.name)}` };
  }
  if (RESERVED_NAMES.has(name)) {
    return { error: `shard name "${name}" is reserved for core shards` };
  }
  if (takenNames.has(name)) {
    return { error: `duplicate shard name "${name}"` };
  }
  if (!Number.isInteger(raw.order) || raw.order < COMPONENT_ORDER_MIN) {
    return { error: `shard "${name}" order must be an integer >= ${COMPONENT_ORDER_MIN}` };
  }
  if (typeof raw.emitter !== 'string' || !raw.emitter.trim()) {
    return { error: `shard "${name}" is missing an emitter path` };
  }

  const claudeRoot = normalizedClaudeRoot(zylosDir);
  const emitterPath = path.isAbsolute(raw.emitter)
    ? path.resolve(raw.emitter)
    : path.resolve(zylosDir, '.claude', raw.emitter);
  if (!`${emitterPath.replaceAll('\\', '/')}`.startsWith(claudeRoot)) {
    return { error: `shard "${name}" emitter must live under ${claudeRoot}` };
  }

  const budget = validateBudget(raw.budget);
  if (!budget) {
    return { error: `shard "${name}" has an invalid budget` };
  }

  const claimHooks = [];
  for (const claim of Array.isArray(raw.claimHooks) ? raw.claimHooks : []) {
    if (!isRelativeClaimPath(claim)) {
      return { error: `shard "${name}" claimHooks entries must be paths relative to ${claudeRoot} (got ${JSON.stringify(claim)})` };
    }
    claimHooks.push(claim.replace(/^\.\//, ''));
  }

  return {
    declaration: { name, order: raw.order, emitterPath, budget, claimHooks },
  };
}

/**
 * Load component shard declarations from <zylosDir>/.zylos/shards.d/*.json.
 * Invalid declarations are skipped (collected in `warnings`), never fatal —
 * a malformed component file must not break session start or hook sync.
 */
export function loadComponentShardDeclarations({ zylosDir = defaultZylosDir() } = {}) {
  const dir = shardsDeclarationDir(zylosDir);
  const declarations = [];
  const warnings = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort();
  } catch {
    return { declarations, warnings };
  }

  const takenNames = new Set();
  for (const file of files) {
    const filePath = path.join(dir, file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      warnings.push(`${file}: unreadable declaration (${error.message})`);
      continue;
    }
    const result = validateDeclaration(raw, { zylosDir, takenNames });
    if (result.error) {
      warnings.push(`${file}: ${result.error}`);
      continue;
    }
    takenNames.add(result.declaration.name);
    declarations.push(result.declaration);
  }

  declarations.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return { declarations, warnings };
}

async function emitComponentShard(declaration, payload) {
  const module = await import(pathToFileURL(declaration.emitterPath).href);
  const emit = module.emit ?? module.default;
  if (typeof emit !== 'function') {
    throw new Error(`emitter ${declaration.emitterPath} exports no emit() function`);
  }
  return emit(payload);
}

/**
 * Build the injection chain: core shards followed by registered component
 * shards, each annotated with its 0-based chainIndex. The chain length N is
 * decided at runtime from this result — headers ([k/N]) and the start-prompt
 * chain-tail wait both derive from it, never from a hardcoded count.
 */
export function buildChain({ zylosDir = defaultZylosDir() } = {}) {
  const { declarations, warnings } = loadComponentShardDeclarations({ zylosDir });
  const chain = [
    ...CORE_SHARDS.map(shard => ({ ...shard, budget: { ...DEFAULT_SHARD_BUDGET }, source: 'core' })),
    ...declarations.map(declaration => ({
      name: declaration.name,
      order: declaration.order,
      budget: declaration.budget,
      source: 'component',
      emit: payload => emitComponentShard(declaration, payload),
    })),
  ].map((shard, index) => ({ ...shard, chainIndex: index }));
  return { chain, warnings };
}

/**
 * Resolve a --shard argument to either a content shard (with chain position)
 * or a side-effect step. Returns null for unknown names.
 */
export function resolveShard(name, { zylosDir = defaultZylosDir() } = {}) {
  const { chain, warnings } = buildChain({ zylosDir });
  if (name === SIDE_EFFECT_NAMES.foreground || name === SIDE_EFFECT_NAMES.startPrompt) {
    return { kind: 'side-effect', name, chain, warnings };
  }
  const shard = chain.find(entry => entry.name === name);
  if (!shard) return null;
  return { kind: 'content', shard, chain, warnings };
}

/**
 * Token estimate for budget enforcement, calibrated against Codex's
 * per-hook cap: ~4 chars/token for ASCII (11,000 chars measured as 2,750
 * tokens) and ~1.34 chars/token for common CJK (8,000 chars measured as
 * 5,970 tokens); 1.3 is used so the estimate errs high, never low —
 * an underestimate here means Codex elides the shard mid-body.
 */
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (ch.codePointAt(0) <= 0x7f) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other / 1.3);
}

export function withinBudget(text, budget = DEFAULT_SHARD_BUDGET) {
  return text.length <= budget.maxChars && estimateTokens(text) <= budget.maxTokens;
}

/**
 * Trim `text` from the tail until it satisfies both budget limits.
 */
export function fitToBudget(text, budget = DEFAULT_SHARD_BUDGET) {
  const original = String(text);
  if (withinBudget(original, budget)) {
    return { text: original, truncated: false, originalChars: original.length };
  }
  let keep = Math.min(original.length, Math.max(0, budget.maxChars));
  let slice = original.slice(0, keep);
  while (keep > 0 && estimateTokens(slice) > budget.maxTokens) {
    const ratio = budget.maxTokens / estimateTokens(slice);
    keep = Math.min(keep - 1, Math.floor(keep * ratio));
    slice = original.slice(0, Math.max(0, keep));
  }
  return { text: slice, truncated: true, originalChars: original.length };
}
