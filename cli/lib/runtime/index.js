/** Runtime selection is explicit: use the observed runtime or resolved configuration. */
export const SUPPORTED_RUNTIMES = Object.freeze(['claude', 'codex', 'agy']);
const cache = new Map();

export async function getRuntime(id) {
  if (typeof id !== 'string' || !SUPPORTED_RUNTIMES.includes(id)) {
    throw Object.assign(new Error(`Unsupported runtime: ${String(id)}`), { code: 'RUNTIME_UNSUPPORTED' });
  }
  if (!cache.has(id)) {
    const pending = import(`./${id}/index.js`).then(module => module.default).catch(error => {
      cache.delete(id);
      throw error;
    });
    cache.set(id, pending);
  }
  return cache.get(id);
}

export async function findRuntime(id) {
  if (typeof id !== 'string' || !SUPPORTED_RUNTIMES.includes(id)) return null;
  return getRuntime(id);
}
