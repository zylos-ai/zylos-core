import { existsSync } from 'node:fs';
import { loadCoreModule } from '../core-modules.js';
import { DASHBOARD_CAPABILITIES, UNSUPPORTED } from './contract.js';

const { SUPPORTED_RUNTIMES, runtimesWith } = await loadCoreModule('runtime/descriptors.js');
const withImplementations = new Set([...runtimesWith('usage'), ...runtimesWith('modelOverride')]);
const cache = new Map();

export function getDashboardRuntime(id) {
  if (typeof id !== 'string' || !SUPPORTED_RUNTIMES.includes(id)) {
    return Promise.reject(Object.assign(new Error(`Unsupported runtime: ${String(id)}`), { code: 'RUNTIME_UNSUPPORTED' }));
  }
  if (!cache.has(id)) {
    const file = new URL(`./${id}/index.js`, import.meta.url);
    const pending = !withImplementations.has(id) && !existsSync(file)
      ? Promise.resolve(Object.freeze({
        id,
        ...Object.fromEntries(Object.keys(DASHBOARD_CAPABILITIES).map(capability => [capability, UNSUPPORTED])),
      }))
      : import(file.href).then(module => module.default).catch(error => {
        cache.delete(id);
        throw error;
      });
    cache.set(id, pending);
  }
  return cache.get(id);
}
