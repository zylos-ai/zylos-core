import { UNSUPPORTED } from '../contract.js';

const DEFAULT_CLAUDE_MODEL_PRICES = {
  // cacheCreation is the 1-HOUR cache-write rate (2x input). 5-minute writes
  // cost 1.25x input and are NOT tabulated here — the collector derives them
  // from `input` per TTL (see CACHE_WRITE_INPUT_MULTIPLIER in
  // collector.js), so changing an input price below
  // moves both TTL rates with it. Cache-read rates are model-specific.
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheCreation: 20 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1.00, cacheCreation: 20 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheCreation: 20 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1, cacheCreation: 20 },
  // Current Fast mode rates apply only to these models (pricing checked 2026-09-28).
  // Opus 5.5 needs its own key: longest-prefix matching would otherwise bill it as
  // claude-opus-5. Its cache reads are 0.05x input rather than the usual 0.1x.
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.20, cacheCreation: 8, fastModeMultiplier: 2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10, fastModeMultiplier: 2 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10, fastModeMultiplier: 2 },
  'claude-opus-4': { input: 5, output: 25, cacheRead: 0.50, cacheCreation: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.20, cacheCreation: 4 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.30, cacheCreation: 6 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.10, cacheCreation: 2 }
};

export default Object.freeze({
  id: 'claude',
  defaultModelPrices: DEFAULT_CLAUDE_MODEL_PRICES,
  serviceTiers: UNSUPPORTED,
  fastMode: Object.freeze({ mode: 'multiplier', defaultMultiplier: 6 }),
  legacyKeys: Object.freeze({ modelPrices: 'modelPrices', fastModeMultiplier: 'fastModeMultiplier' }),
});
