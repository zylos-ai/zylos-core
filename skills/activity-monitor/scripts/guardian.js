/** Observation only. Runtime creation and restart scheduling belong to M1. */
export async function observeRuntimeProcess(adapter, { tmuxName }) {
  if (typeof tmuxName !== 'string' || !tmuxName) throw new TypeError('An explicit tmux target is required');
  const observation = await adapter.isRunning({ tmuxName });
  if (!observation || typeof observation.tmux !== 'boolean' || typeof observation.process !== 'boolean') {
    throw Object.assign(new Error('Runtime liveness is unknown'), { code: 'TMUX_UNAVAILABLE', cause: 'error' });
  }
  return { ...observation, state: !observation.tmux ? 'offline' : observation.process ? 'running' : 'stopped' };
}
