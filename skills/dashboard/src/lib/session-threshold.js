import fs from 'node:fs';
import path from 'node:path';
import { loadCoreModule } from './core-modules.js';

const { SUPPORTED_RUNTIMES } = await loadCoreModule('runtime/descriptors.js');
const { modelThreshold, loadRuntimeContexts, readDefaultModels, readModelWindows } = await loadCoreModule('model-rotation-thresholds.js');
const { usageModelFacts } = await loadCoreModule('session-usage-reader.js');

/** One snapshot supplies all session rows; usage identity is owned by the caller. */
export async function readThresholdPolicy(zylosDir) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos/config.json'), 'utf8')); } catch {}
  const contexts = await loadRuntimeContexts();
  return { config, contexts, defaultModels: readDefaultModels({ zylosDir, contexts }), modelWindows: readModelWindows({ contexts }) };
}

export function sessionThreshold(policy, { runtime, usage, launchConfig, desiredModel } = {}) {
  if (!SUPPORTED_RUNTIMES.includes(runtime)) return null;
  const context = policy.contexts[runtime];
  const facts = desiredModel !== undefined ? { model: desiredModel } : usageModelFacts(usage, runtime, launchConfig, context);
  if (!facts.model) return null;
  return modelThreshold(policy.config, { runtime, context, ...facts,
    launchConfig,
    defaultModel: policy.defaultModels[runtime], modelWindows: policy.modelWindows });
}
