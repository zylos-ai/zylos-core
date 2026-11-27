import fs from 'node:fs';
import path from 'node:path';
import { readJsonSample } from '../../session-usage-reader.js';
import { UNSUPPORTED } from '../contract.js';

// Models measured to run at a 1M window on Claude Code (claude -p --output-format json, 2026-11-28).
// Other names count as 1M only with the `[1m]` suffix.
const ONE_MILLION_MODELS = new Set(['fable', 'opus', 'sonnet', 'haiku',
  'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);

export const context = Object.freeze({
  readUsageSample: ({ dir }) => readJsonSample(path.join(dir, 'statusline.json'), 'usage'),
  usageSampleExpires: true,
  usageFacts: value => ({
    model: value?.model?.id,
    contextWindow: value?.context_window?.context_window_size,
    usedPercent: value?.context_window?.used_percentage,
    usedTokens: null,
    effort: value?.effort?.level ?? value?.reasoningEffort ?? value?.reasoning_effort,
    version: value?.version ?? value?.cliVersion,
  }),
  contextWindowFor: model => ONE_MILLION_MODELS.has(String(model ?? '').trim().toLowerCase()) ? 1_000_000 : null,
  readModelWindows: UNSUPPORTED,
  thresholdKeys: Object.freeze({
    key: (model, large) => large && !model.toLowerCase().includes('[1m]') ? `${model}[1m]` : model,
    alias(key, large) {
      const family = key.replace(/\[1m\]/ig, '').match(/^(?:claude-)?(fable|opus|sonnet|haiku)(?:-|$)/)?.[1];
      return family ? `${family}${large ? '[1m]' : ''}` : null;
    },
    isAlias: model => typeof model === 'string' && /^(fable|opus|sonnet|haiku)(\[1m\])?$/.test(model.trim()),
  }),
  readDefaultModel({ zylosDir }) {
    try {
      const { model } = JSON.parse(fs.readFileSync(path.join(zylosDir, '.claude/settings.json'), 'utf8'));
      return typeof model === 'string' ? model.trim() || null : null;
    } catch { return null; }
  },
  statusLine: Object.freeze({ normalize: sample => sample }),
});
