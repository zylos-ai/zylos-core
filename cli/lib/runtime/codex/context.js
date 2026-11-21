import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexSampleForIdentity } from './rollout.js';
import { UNSUPPORTED } from '../contract.js';

// Codex rewrites its model cache when it updates; a changed file is parsed again,
// an unchanged one is not. Callers treat the returned list as read-only.
const codexModelCache = new Map();
const fileSignature = file => {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return null; }
};

function readModelWindows({ home = os.homedir(), env = process.env } = {}) {
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const file = path.join(codexHome, 'models_cache.json');
  const before = fileSignature(file);
  const cached = codexModelCache.get(file);
  if (before && cached?.signature === before) return cached.models;
  let models;
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    models = Array.isArray(cache.models) ? cache.models : [];
  } catch {
    // A transient read failure must not become a cached empty model list.
    codexModelCache.delete(file);
    return [];
  }
  // Keep only a result whose file did not change while it was read.
  if (before && fileSignature(file) === before) codexModelCache.set(file, { signature: before, models });
  else codexModelCache.delete(file);
  return models;
}

export const context = Object.freeze({
  readUsageSample({ sessionGroup, identity, env }) {
    const found = readCodexSampleForIdentity({ sessionGroup, identity, env });
    if (!found) return { error: 'missing', sampledAt: null };
    const { sample } = found;
    return { value: sample, sampledAt: sample.capturedAt, identity: sample.identity };
  },
  usageSampleExpires: true,
  usageFacts: value => ({
    model: value?.model,
    contextWindow: value?.contextUsage?.ceiling,
    usedPercent: null,
    usedTokens: value?.contextUsage?.used,
    effort: null,
    version: null,
  }),
  contextWindowFor(model, windows) {
    const window = Number((windows ?? []).find(entry => entry?.slug === model)?.context_window);
    return Number.isFinite(window) ? window : null;
  },
  readModelWindows,
  thresholdKeys: Object.freeze({
    key: model => model,
    alias: () => null,
    isAlias: () => false,
  }),
  readDefaultModel({ zylosDir }) {
    try {
      // Only root TOML keys belong to the instance defaults; ignore table values.
      const root = fs.readFileSync(path.join(zylosDir, '.codex/config.toml'), 'utf8').split(/^\s*\[/m)[0];
      const match = root.match(/^\s*model\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m);
      return match ? (match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1)) : null;
    } catch { return null; }
  },
  statusLine: UNSUPPORTED,
});
