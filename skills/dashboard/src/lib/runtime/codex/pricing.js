import { UNSUPPORTED } from '../contract.js';

// OpenAI API pricing, USD/1M tokens, checked 2026-09-28:
// https://developers.openai.com/api/docs/pricing
// GPT-5.6+ writes replace ordinary input at 1.25x. Above 272K total input,
// the entire request uses long-context prices, including cached/write input.
// Sol's current promotional price is available at least through 2026-11-21.
// GPT-6.1 Sol checked 2026-09-30: cached input is 0.05x input, not 0.1x.
// GPT-6.2 Sol/Astra and GPT-6.1 Terra checked 2026-11-18 against the pricing page
// above (GPT-6.2 also https://openai.com/index/introducing-gpt-6-2-astra-sol/):
// cached input is 0.05x input; Fast (priority) is 2x standard.
function codexPrice(input, output, cacheRead, cacheCreation) {
  return {
    input, output, cacheRead, cacheCreation,
    longContext: {
      inputTokenThreshold: 272000,
      input: input * 2, output: output * 1.5,
      cacheRead: cacheRead * 2, cacheCreation: cacheCreation * 2
    }
  };
}

const DEFAULT_CODEX_MODEL_PRICES = {
  'gpt-6.2-sol': codexPrice(2, 10, 0.1, 2.5),
  'gpt-6.2-astra': codexPrice(8, 40, 0.4, 10),
  'gpt-6-astra': codexPrice(10, 50, 1, 12.5),
  'gpt-6.1-sol': codexPrice(2, 10, 0.1, 2.5),
  'gpt-6.1-terra': codexPrice(1, 5, 0.05, 1.25),
  'gpt-6-sol': codexPrice(2, 10, 0.2, 2.5),
  'gpt-6-luna': codexPrice(0.1, 0.5, 0.01, 0.125),
  'gpt-5.6-sol': codexPrice(4, 20, 0.4, 5),
  'gpt-5.6-terra': codexPrice(2, 12, 0.2, 2.5),
  'gpt-5.6-luna': codexPrice(0.2, 1.2, 0.02, 0.25),
  'gpt-5.6': codexPrice(4, 20, 0.4, 5),
  // Earlier models have no separate cache-write surcharge. GPT-5.5 and GPT-5.4
  // still switch the entire request to long-context prices above 272K input
  // (standard/batch/flex only; their priority rates below stay flat).
  'gpt-5.5': {
    input: 5, output: 30, cacheRead: 0.50, cacheCreation: 5,
    longContext: { inputTokenThreshold: 272000, input: 10, output: 45, cacheRead: 1, cacheCreation: 10 }
  },
  'gpt-5.4-mini': { input: 0.75, output: 4.50, cacheRead: 0.075, cacheCreation: 0.75 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25, cacheRead: 0.02, cacheCreation: 0.20 },
  'gpt-5.4': {
    input: 2.50, output: 15, cacheRead: 0.25, cacheCreation: 2.50,
    longContext: { inputTokenThreshold: 272000, input: 5, output: 22.50, cacheRead: 0.50, cacheCreation: 5 }
  },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 1.75 },
  'gpt-5.2-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 1.75 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheCreation: 0.25 },
  'gpt-5.1-codex-max': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'codex-mini-latest': { input: 1.50, output: 6, cacheRead: 0.375, cacheCreation: 1.50 },
  'gpt-5.2-chat-latest': { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 1.75 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 1.75 },
  'gpt-5.1-chat-latest': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'gpt-5-chat-latest': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheCreation: 0.25 },
  'gpt-5-nano': { input: 0.05, output: 0.40, cacheRead: 0.005, cacheCreation: 0.05 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 1.25 }
};

const DEFAULT_CODEX_PRIORITY_MODEL_PRICES = {
  'gpt-6.2-sol': codexPrice(4, 20, 0.2, 5),
  'gpt-6.2-astra': codexPrice(16, 80, 0.8, 20),
  'gpt-6-astra': codexPrice(20, 100, 2, 25),
  'gpt-6.1-sol': codexPrice(4, 20, 0.2, 5),
  'gpt-6.1-terra': codexPrice(2, 10, 0.1, 2.5),
  'gpt-6-sol': codexPrice(4, 20, 0.4, 5),
  'gpt-6-luna': codexPrice(0.2, 1, 0.02, 0.25),
  'gpt-5.6-sol': codexPrice(8, 40, 0.8, 10),
  'gpt-5.6-terra': codexPrice(4, 24, 0.4, 5),
  'gpt-5.6-luna': codexPrice(0.4, 2.4, 0.04, 0.5),
  'gpt-5.6': codexPrice(8, 40, 0.8, 10),
  // OpenAI Priority processing prices per 1M tokens. Codex /fast maps to the
  // priority service tier for models that expose a Fast tier in Codex metadata.
  'gpt-5.5': { input: 12.50, output: 75, cacheRead: 1.25, cacheCreation: 12.50 },
  'gpt-5.4-mini': { input: 1.50, output: 9, cacheRead: 0.15, cacheCreation: 1.50 },
  'gpt-5.4': { input: 5, output: 30, cacheRead: 0.50, cacheCreation: 5 },
  'gpt-5.3-codex': { input: 3.50, output: 28, cacheRead: 0.35, cacheCreation: 3.50 }
};

export default Object.freeze({
  id: 'codex',
  defaultModelPrices: DEFAULT_CODEX_MODEL_PRICES,
  serviceTiers: Object.freeze({ priority: DEFAULT_CODEX_PRIORITY_MODEL_PRICES }),
  fastMode: Object.freeze({ mode: 'service_tier', serviceTier: 'priority' }),
  legacyKeys: UNSUPPORTED,
});
