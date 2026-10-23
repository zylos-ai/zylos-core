import { Worker } from 'node:worker_threads';
import { resolveCoreConfigModule } from './core-config-loader.js';

// Private construction seam for isolated transports. Public callers never choose
// a tmux object or connection; each observation owns one short-lived connection.
export function createCoreObserver({ tmux = {}, timeoutMs = 15000 } = {}) {
  function observe(method, options) {
    const shared = new SharedArrayBuffer(8 + 1024 * 1024);
    const control = new Int32Array(shared, 0, 2);
    const worker = new Worker(new URL('./c4-runtime-observer-worker.js', import.meta.url), {
      workerData: { method, options, tmux, coreConfigPath: resolveCoreConfigModule(), shared },
    });
    worker.on('error', () => {});
    const status = Atomics.wait(control, 0, 0, timeoutMs);
    if (status === 'timed-out') {
      void worker.terminate();
      throw Object.assign(new Error('Core target observation timed out'), { code: 'TARGET_SNAPSHOT_UNKNOWN' });
    }
    const length = Atomics.load(control, 1);
    const result = JSON.parse(new TextDecoder().decode(new Uint8Array(shared, 8, length)));
    if (result.error) throw Object.assign(new Error(result.error.message), result.error);
    return result.value;
  }
  return {
    observeCoreTarget: options => observe('target', options),
    observeCoreRunning: options => observe('running', options),
  };
}

const observer = createCoreObserver();
export const observeCoreTarget = options => observer.observeCoreTarget(options);
export const observeCoreRunning = options => observer.observeCoreRunning(options);
