import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { ObserverContainmentError } from './observer-containment-error.js';
import { TmuxObserverContainment } from './observer-containment-tmux.js';

class UnsupportedObserverContainment extends EventEmitter {
  constructor({ dataDir, platform, arch }) {
    super();
    this.runtimeRoot = path.join(dataDir, 'observer', 'runtime', 'generations');
    this.platform = platform;
    this.arch = arch;
    this.active = null;
  }

  async verifyHelpers() {
    throw new ObserverContainmentError('unsupported_platform', `Unsupported containment platform: ${this.platform}-${this.arch}`);
  }

  async startGeneration() { return this.verifyHelpers(); }

  async resizeAgent() { return this.verifyHelpers(); }

  async stopGeneration({ reason = 'stop' } = {}) { return { stopped: true, reason, count: 0 }; }

  async reconcilePersisted() {
    try {
      const entries = await fs.promises.readdir(this.runtimeRoot);
      // Startup on unsupported hosts is harmless only when there is no state
      // to recover. Never silently discard a generation from another platform.
      if (entries.length > 0) return this.verifyHelpers();
      return [];
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }
}

export function createObserverContainment(options) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const resolved = { ...options, platform, arch };
  if (platform === 'darwin' && arch === 'arm64') return new TmuxObserverContainment(resolved);
  if (platform === 'linux' && ['x64', 'arm64'].includes(arch)) return new TmuxObserverContainment(resolved);
  return new UnsupportedObserverContainment(resolved);
}
