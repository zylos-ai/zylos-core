import fs from 'node:fs';
import path from 'node:path';
import { loadCoreModule } from './core-modules.js';
const { modelThreshold, readDefaultModels, readCodexModelWindows } = await loadCoreModule('model-rotation-thresholds.js');
const { usageModelFacts } = await loadCoreModule('session-usage-reader.js');

/** One snapshot supplies all session rows; usage identity is owned by the caller. */
export function readThresholdPolicy(zylosDir) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos/config.json'), 'utf8')); } catch {}
  return { config, defaultModels: readDefaultModels({ zylosDir }), codexModels: readCodexModelWindows() };
}

export function sessionThreshold(policy, { runtime, usage, launchConfig, desiredModel } = {}) {
  if (!['claude', 'codex'].includes(runtime)) return null;
  const facts = desiredModel !== undefined ? { model: desiredModel } : usageModelFacts(usage, runtime, launchConfig);
  if (!facts.model) return null;
  return modelThreshold(policy.config, { runtime, ...facts,
    defaultModel: policy.defaultModels[runtime], codexModels: policy.codexModels });
}
