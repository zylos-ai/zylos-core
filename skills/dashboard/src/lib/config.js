import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { avatarFileInfo } from './instance-avatar.js';
import { validateFleetRegistry } from './fleet-registry.js';
import { UNSUPPORTED } from './runtime/contract.js';

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
  return { name, id, avatar: avatarFileInfo(configured.avatar) ? configured.avatar : null };
}

export function loadConfig({ zylosDir = getZylosDir(), pricing = {} } = {}) {
  const dataDir = getDataDir(zylosDir);
  const configPath = path.join(dataDir, 'config.json');
  const defaults = {
    port: 3470,
    host: '127.0.0.1',
    // allowRemote governs remote (API key) access to both conversations and the terminal observer.
    chat: { allowRemote: false },
    zylosDir,
    dataDir,
    auth: {
      password: null,
      allowUrlTokenOnLocalhost: false
    },
    observer: {
      enabled: false,
      idleGraceMs: 5000,
      leaseTtlMs: 30000,
      maxViewers: 4
    },
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
  const runtimeModelPrices = {};
  const loadedServiceTierPrices = loaded.runtimeServiceTierModelPrices || {};
  const runtimeServiceTierModelPrices = { ...loadedServiceTierPrices };
  // Explicit values take precedence over model-specific multipliers.
  const configuredRuntimeFastModeMultipliers = { ...(loaded.runtimeFastModeMultipliers || {}) };
  const runtimeFastModeMultipliers = { ...configuredRuntimeFastModeMultipliers };
  const legacyPricing = {};
  for (const { id, defaultModelPrices, serviceTiers, fastMode, legacyKeys } of Object.values(pricing)) {
    const legacy = legacyKeys === UNSUPPORTED ? null : legacyKeys;
    runtimeModelPrices[id] = {
      ...defaultModelPrices,
      ...(loaded.runtimeModelPrices?.[id] || (legacy && loaded[legacy.modelPrices]) || {}),
    };
    if (fastMode !== UNSUPPORTED && fastMode.mode === 'multiplier') {
      const override = loaded.runtimeFastModeMultipliers?.[id] ?? (legacy && loaded[legacy.fastModeMultiplier]);
      if (override != null) configuredRuntimeFastModeMultipliers[id] = Number(override);
      runtimeFastModeMultipliers[id] = Number(override ?? fastMode.defaultMultiplier);
    }
    if (serviceTiers !== UNSUPPORTED) {
      const overrides = loadedServiceTierPrices[id] || {};
      runtimeServiceTierModelPrices[id] = { ...overrides };
      for (const [tier, table] of Object.entries(serviceTiers)) {
        runtimeServiceTierModelPrices[id][tier] = { ...table, ...(overrides[tier] || {}) };
      }
    }
    if (legacy) {
      legacyPricing[legacy.modelPrices] = runtimeModelPrices[id];
      legacyPricing[legacy.fastModeMultiplier] = runtimeFastModeMultipliers[id];
    }
  }
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
    configuredRuntimeFastModeMultipliers,
    runtimeFastModeMultipliers,
    ...legacyPricing,
    agent: resolveAgentIdentity(loaded, zylosDir),
    fleet: {
      ...(loaded.fleet || {}),
      agents: fleetRegistry.agents,
      validation_errors: fleetRegistry.errors
    },
    configPath,
    chat: { allowRemote: loaded.chat?.allowRemote === true },
    configError: loaded.configError || null
  };
}

function requirePricing(pricing) {
  if (!pricing || pricing === UNSUPPORTED || typeof pricing !== 'object') {
    throw Object.assign(new TypeError('PRICING_UNSUPPORTED'), { code: 'PRICING_UNSUPPORTED' });
  }
}

export function modelPricesForRuntime(config, pricing, serviceTier = 'standard') {
  requirePricing(pricing);
  const { id, serviceTiers, legacyKeys } = pricing;
  const tier = normalizeServiceTier(serviceTier);
  if (tier !== 'standard' && serviceTiers !== UNSUPPORTED && serviceTiers[tier]) {
    return config?.runtimeServiceTierModelPrices?.[id]?.[tier] || serviceTiers[tier];
  }
  const legacy = legacyKeys === UNSUPPORTED ? undefined : config?.[legacyKeys.modelPrices];
  return config?.runtimeModelPrices?.[id] || legacy || {};
}

export function fastModeMultiplierForRuntime(config, pricing, price = null) {
  requirePricing(pricing);
  const { id, legacyKeys } = pricing;
  const legacy = legacyKeys === UNSUPPORTED ? null : config?.[legacyKeys.fastModeMultiplier];
  const multiplier = config?.runtimeFastModeMultipliers?.[id] ?? legacy ?? null;
  if (price) {
    const explicit = config?.configuredRuntimeFastModeMultipliers;
    const override = explicit === undefined ? multiplier : explicit[id];
    if (override != null) return override;
    if (price.fastModeMultiplier != null) return price.fastModeMultiplier;
  }
  return multiplier;
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
