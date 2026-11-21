import { DEFAULT_CODEX_MODEL_PRICES, DEFAULT_CODEX_PRIORITY_MODEL_PRICES } from '../../config.js';
import { UNSUPPORTED } from '../contract.js';

export default Object.freeze({
  id: 'codex',
  defaultModelPrices: DEFAULT_CODEX_MODEL_PRICES,
  serviceTiers: Object.freeze({ priority: DEFAULT_CODEX_PRIORITY_MODEL_PRICES }),
  fastMode: Object.freeze({ mode: 'service_tier', serviceTier: 'priority' }),
  legacyKeys: UNSUPPORTED,
});
