import { DEFAULT_CLAUDE_MODEL_PRICES, DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS } from '../../config.js';
import { UNSUPPORTED } from '../contract.js';

export default Object.freeze({
  id: 'claude',
  defaultModelPrices: DEFAULT_CLAUDE_MODEL_PRICES,
  serviceTiers: UNSUPPORTED,
  fastMode: Object.freeze({ mode: 'multiplier', defaultMultiplier: DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS.claude }),
  legacyKeys: Object.freeze({ modelPrices: 'modelPrices', fastModeMultiplier: 'fastModeMultiplier' }),
});
