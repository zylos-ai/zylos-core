import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateFleetRegistry } from './fleet-registry.js';

export const DEFAULT_CLAUDE_MODEL_PRICES = {
  // cacheCreation is the 1-HOUR cache-write rate (2x input). 5-minute writes
  // cost 1.25x input and are NOT tabulated here — the collector derives them
  // from `input` per TTL (see CACHE_WRITE_INPUT_MULTIPLIER in
  // collectors/conversation-collector.js), so changing an input price below
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

// OpenAI API pricing, USD/1M tokens, checked 2026-09-28:
// https://developers.openai.com/api/docs/pricing
// GPT-5.6+ writes replace ordinary input at 1.25x. Above 272K total input,
// the entire request uses long-context prices, including cached/write input.
// Sol's current promotional price is available at least through 2026-11-21.
// GPT-6.1 Sol checked 2026-09-30: cached input is 0.05x input, not 0.1x.
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

export const DEFAULT_CODEX_MODEL_PRICES = {
  'gpt-6-astra': codexPrice(10, 50, 1, 12.5),
  'gpt-6.1-sol': codexPrice(2, 10, 0.1, 2.5),
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

export const DEFAULT_CODEX_PRIORITY_MODEL_PRICES = {
  'gpt-6-astra': codexPrice(20, 100, 2, 25),
  'gpt-6.1-sol': codexPrice(4, 20, 0.2, 5),
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

export const DEFAULT_RUNTIME_MODEL_PRICES = {
  claude: DEFAULT_CLAUDE_MODEL_PRICES,
  codex: DEFAULT_CODEX_MODEL_PRICES
};

export const DEFAULT_RUNTIME_SERVICE_TIER_MODEL_PRICES = {
  codex: {
    priority: DEFAULT_CODEX_PRIORITY_MODEL_PRICES
  }
};

export const DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS = {
  claude: 6
};

export function getZylosDir() {
  return process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
}

export function getDataDir(zylosDir = getZylosDir()) {
  return path.join(zylosDir, 'components', 'dashboard');
}

function slugifyIdentity(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'zylos';
}

export function resolveAgentIdentity(loaded = {}, zylosDir = getZylosDir()) {
  const configured = loaded.agent && typeof loaded.agent === 'object' && !Array.isArray(loaded.agent)
    ? loaded.agent
    : {};
  const fallbackName = process.env.ZYLOS_AGENT_NAME || os.hostname() || path.basename(zylosDir) || 'zylos';
  const name = String(configured.name || loaded.agentName || fallbackName).trim() || fallbackName;
  const id = String(configured.id || loaded.agentId || slugifyIdentity(name)).trim() || slugifyIdentity(name);
  return { name, id };
}

export function loadConfig() {
  const zylosDir = getZylosDir();
  const dataDir = getDataDir(zylosDir);
  const configPath = path.join(dataDir, 'config.json');
  const defaults = {
    port: 3470,
    host: '127.0.0.1',
    zylosDir,
    dataDir,
    auth: {
      enabled: true,
      password: null,
      allowUrlTokenOnLocalhost: false
    },
    observer: {
      enabled: false,
      idleGraceMs: 5000,
      leaseTtlMs: 30000,
      maxViewers: 4
    },
    runtimeModelPrices: DEFAULT_RUNTIME_MODEL_PRICES,
    runtimeServiceTierModelPrices: DEFAULT_RUNTIME_SERVICE_TIER_MODEL_PRICES,
    runtimeFastModeMultipliers: DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS
  };

  let loaded = {};
  try {
    if (fs.existsSync(configPath)) {
      loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (err) {
    loaded = { configError: err.message };
  }

  // Overrides replace whole rows. Custom long-context tariffs must be supplied
  // in that row; do not silently apply the default surcharge to a custom rate.
  const runtimeModelPrices = {
    claude: {
      ...DEFAULT_CLAUDE_MODEL_PRICES,
      ...(loaded.runtimeModelPrices?.claude || loaded.modelPrices || {})
    },
    codex: {
      ...DEFAULT_CODEX_MODEL_PRICES,
      ...(loaded.runtimeModelPrices?.codex || {})
    }
  };
  // Keep explicit values separate: a default 6 must not mask model-specific
  // defaults, but an operator's explicit 6 (including the legacy key) must win.
  const configuredRuntimeFastModeMultipliers = { ...(loaded.runtimeFastModeMultipliers || {}) };
  if (loaded.runtimeFastModeMultipliers?.claude != null || loaded.fastModeMultiplier != null) {
    configuredRuntimeFastModeMultipliers.claude = Number(loaded.runtimeFastModeMultipliers?.claude ?? loaded.fastModeMultiplier);
  }
  const runtimeFastModeMultipliers = {
    ...DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS,
    ...(loaded.runtimeFastModeMultipliers || {}),
    claude: Number(loaded.runtimeFastModeMultipliers?.claude ?? loaded.fastModeMultiplier ?? DEFAULT_RUNTIME_FAST_MODE_MULTIPLIERS.claude)
  };
  const loadedServiceTierPrices = loaded.runtimeServiceTierModelPrices || {};
  const runtimeServiceTierModelPrices = {
    ...loadedServiceTierPrices,
    codex: {
      ...(loadedServiceTierPrices.codex || {}),
      priority: {
        ...DEFAULT_CODEX_PRIORITY_MODEL_PRICES,
        ...(loadedServiceTierPrices.codex?.priority || {})
      }
    }
  };
  const fleetRegistry = validateFleetRegistry(loaded.fleet?.agents);

  return {
    ...defaults,
    ...loaded,
    port: Number(loaded.port || defaults.port),
    host: loaded.host || defaults.host,
    zylosDir: loaded.zylosDir || defaults.zylosDir,
    dataDir,
    auth: {
      ...defaults.auth,
      ...(loaded.auth || {})
    },
    observer: (() => {
      const value = loaded.observer && typeof loaded.observer === 'object' && !Array.isArray(loaded.observer)
        ? loaded.observer
        : {};
      const boundedInteger = (candidate, fallback, minimum, maximum) => {
        const number = Number(candidate);
        return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
      };
      return {
        ...value,
        enabled: value.enabled === true,
        idleGraceMs: boundedInteger(value.idleGraceMs, defaults.observer.idleGraceMs, 0, 30_000),
        leaseTtlMs: boundedInteger(value.leaseTtlMs, defaults.observer.leaseTtlMs, 10_000, 120_000),
        maxViewers: boundedInteger(value.maxViewers, defaults.observer.maxViewers, 1, 16),
      };
    })(),
    runtimeModelPrices,
    runtimeServiceTierModelPrices,
    modelPrices: runtimeModelPrices.claude,
    configuredRuntimeFastModeMultipliers,
    runtimeFastModeMultipliers,
    fastModeMultiplier: runtimeFastModeMultipliers.claude,
    agent: resolveAgentIdentity(loaded, zylosDir),
    fleet: {
      ...(loaded.fleet || {}),
      agents: fleetRegistry.agents,
      validation_errors: fleetRegistry.errors
    },
    configPath,
    configError: loaded.configError || null
  };
}

export function modelPricesForRuntime(config, runtime = config?.runtime, serviceTier = 'standard') {
  const rt = runtime === 'codex' ? 'codex' : 'claude';
  const tier = normalizeServiceTier(serviceTier);
  if (rt === 'codex' && tier === 'priority') {
    return config?.runtimeServiceTierModelPrices?.codex?.priority || DEFAULT_CODEX_PRIORITY_MODEL_PRICES;
  }
  return config?.runtimeModelPrices?.[rt] || config?.modelPrices || {};
}

export function fastModeMultiplierForRuntime(config, runtime = config?.runtime, price = null) {
  const rt = runtime === 'codex' ? 'codex' : 'claude';
  if (price) {
    const explicit = config?.configuredRuntimeFastModeMultipliers;
    const override = explicit !== undefined
      ? explicit[rt]
      : config?.runtimeFastModeMultipliers?.[rt] ?? (rt === 'claude' ? config?.fastModeMultiplier : null);
    if (override != null) return override;
    if (price.fastModeMultiplier != null) return price.fastModeMultiplier;
  }
  return config?.runtimeFastModeMultipliers?.[rt] ?? (rt === 'claude' ? config?.fastModeMultiplier : null) ?? null;
}

export function normalizeServiceTier(serviceTier) {
  if (serviceTier === 'fast' || serviceTier === 'priority') return 'priority';
  return 'standard';
}

export function ensureDataDirs(config = loadConfig()) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'spool'), { recursive: true });
}

export function publicDir() {
  return path.resolve(new URL('../../public', import.meta.url).pathname);
}
