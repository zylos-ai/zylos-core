/** Public, read-only candidate-text budget API. See references/memory-budget.md. */
import { DEFAULT_SHARD_BUDGET, estimateTokens } from '../../activity-monitor/scripts/shard-registry.js';
import { worstCaseShardHeader } from '../../activity-monitor/scripts/shard-format.js';
import { formatSection } from '../../comm-bridge/scripts/session-format.js';

export const MEMORY_PARTS = Object.freeze({
  identity: Object.freeze({ label: 'BOT IDENTITY', file: 'identity.md' }),
  references: Object.freeze({ label: 'REFERENCES', file: 'references.md' }),
});
export const WARN_RATIO = 0.8;

// Empty content renders as `(empty)`; use a nonempty marker to measure only framing.
const wrappers = Object.values(MEMORY_PARTS).map(({ label }) =>
  `${worstCaseShardHeader()}\n${formatSection(label, 'x')}\n`.replace('\nx\n', '\n\n'));
export const STARTUP_MEMORY_LIMIT = Object.freeze({
  maxChars: DEFAULT_SHARD_BUDGET.maxChars - Math.max(...wrappers.map(text => text.length)),
  maxTokens: DEFAULT_SHARD_BUDGET.maxTokens - Math.max(...wrappers.map(estimateTokens)),
});
export const BUDGETS = Object.freeze({
  'identity.md': STARTUP_MEMORY_LIMIT,
  'references.md': STARTUP_MEMORY_LIMIT,
  'reference/projects/INDEX.md': 32 * 1024,
  'reference/decisions/INDEX.md': 32 * 1024,
});
export const WARN_THRESHOLDS = Object.freeze({
  'identity.md': Object.freeze({ chars: STARTUP_MEMORY_LIMIT.maxChars * WARN_RATIO, estimatedTokens: STARTUP_MEMORY_LIMIT.maxTokens * WARN_RATIO }),
  'references.md': Object.freeze({ chars: STARTUP_MEMORY_LIMIT.maxChars * WARN_RATIO, estimatedTokens: STARTUP_MEMORY_LIMIT.maxTokens * WARN_RATIO }),
  'reference/projects/INDEX.md': 16 * 1024,
  'reference/decisions/INDEX.md': 16 * 1024,
});

/** Measure raw candidate text without reading or writing any file. Unknown files throw. */
export function measureMemoryText(file, text) {
  if (typeof text !== 'string') throw new TypeError('memory text must be a string');
  const limit = BUDGETS[file];
  if (!Object.hasOwn(BUDGETS, file)) throw new Error(`No memory budget for ${file}`);
  const sizeBytes = Buffer.byteLength(text);
  if (typeof limit === 'number') {
    const warnBytes = WARN_THRESHOLDS[file];
    const over = sizeBytes > limit;
    const warning = sizeBytes > warnBytes;
    return { sizeBytes, budgetBytes: limit, warnBytes, status: over ? 'over' : warning ? 'warning' : 'ok',
      budgetUsagePct: Math.round(sizeBytes / limit * 100) };
  }
  const chars = text.length;
  const estimatedTokens = estimateTokens(text);
  const warnThreshold = WARN_THRESHOLDS[file];
  const over = chars > limit.maxChars || estimatedTokens > limit.maxTokens;
  const warning = chars >= warnThreshold.chars || estimatedTokens >= warnThreshold.estimatedTokens;
  return { chars, estimatedTokens, sizeBytes, ...limit, warnThreshold,
    status: over ? 'over' : warning ? 'warning' : 'ok',
    budgetUsagePct: Math.round(Math.max(chars / limit.maxChars, estimatedTokens / limit.maxTokens) * 100) };
}
