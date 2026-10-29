import fs from 'node:fs';
import { mutateConfig } from './config-mutation.js';
import { DEFAULT_AGENT_SIZE, validAgentSize } from '../../public/js/observer-size.js';

export class ObserverLifecycleError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ObserverLifecycleError';
    this.code = code;
  }
}

function observerDesired(config) {
  const value = config?.observer;
  return {
    enabled: value?.enabled === true,
    generation: Number.isSafeInteger(value?.generation) && value.generation >= 0 ? value.generation : 0,
    teardownFence: value?.teardownFence === true,
    removalState: typeof value?.removalState === 'string' ? value.removalState : null,
    lastError: typeof value?.lastError === 'string' ? value.lastError : null,
  };
}

export class ObserverCoordinator {
  constructor({ configPath, installer, teardown = async () => {}, reconcilePersisted = async () => {}, start = async () => ({}) }) {
    this.configPath = configPath;
    this.installer = installer;
    this.teardown = teardown;
    this.reconcilePersisted = reconcilePersisted;
    this.start = start;
    this._tail = Promise.resolve();
    this._requestedGeneration = 0;
    this._installPromise = null;
  }

  _requestGeneration() {
    this._requestedGeneration += 1;
    return this._requestedGeneration;
  }

  _enqueue(operation) {
    const result = this._tail.then(operation, operation);
    this._tail = result.catch(() => {});
    return result;
  }

  async _readDesired() {
    try {
      const raw = await fs.promises.readFile(this.configPath, 'utf8');
      const config = JSON.parse(raw);
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('root must be an object');
      return observerDesired(config);
    } catch (error) {
      if (error?.code === 'ENOENT') return observerDesired({});
      throw new ObserverLifecycleError('invalid_config', `Unable to read Observer desired state: ${error.message}`, error);
    }
  }

  async _persist(patch) {
    const { config } = await mutateConfig(this.configPath, (current) => {
      current.observer = { ...(current.observer || {}), ...patch };
    });
    return observerDesired(config);
  }

  // Remembered Set size value, independent of lifecycle desired state.
  async agentSize() {
    let config;
    try {
      config = JSON.parse(await fs.promises.readFile(this.configPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...DEFAULT_AGENT_SIZE };
      throw new ObserverLifecycleError('invalid_config', `Unable to read Observer agent size: ${error.message}`, error);
    }
    const value = config?.observer?.agentSize;
    return validAgentSize(value) ? { cols: value.cols, rows: value.rows } : { ...DEFAULT_AGENT_SIZE };
  }

  async saveAgentSize({ cols, rows }) {
    await mutateConfig(this.configPath, (current) => {
      current.observer = { ...(current.observer || {}), agentSize: { cols, rows } };
    });
    return { cols, rows };
  }

  async status() {
    const [desired, installation] = await Promise.all([
      this._readDesired(),
      this.installer.verify(),
    ]);
    return { ...installation, desired };
  }

  async historyStatus() {
    const [desired, installation] = await Promise.all([
      this._readDesired(),
      this.installer.inspectInstallation(),
    ]);
    return { ...installation, desired };
  }

  installAndEnable({ signal, onProgress } = {}) {
    if (this._installPromise) return this._installPromise;
    const ticket = this._requestGeneration();
    const operation = this._enqueue(async () => {
      const installed = await this.installer.install({
        signal,
        onProgress,
        isCurrent: () => ticket === this._requestedGeneration,
      });
      if (ticket !== this._requestedGeneration) {
        throw new ObserverLifecycleError('operation_obsolete', 'Observer installation was superseded');
      }
      try {
        await this._persist({
          enabled: true,
          generation: ticket,
          teardownFence: false,
          removalState: null,
          lastError: null,
        });
      } catch (error) {
        try {
          await this._persist({ enabled: false, generation: ticket, teardownFence: true, lastError: 'enable_persist_failed' });
        } catch {}
        throw new ObserverLifecycleError('enable_persist_failed', 'Observer was installed but could not be enabled', error);
      }
      return { ...installed, enabled: true, generation: ticket };
    });
    this._installPromise = operation.finally(() => {
      if (this._installPromise === wrapped) this._installPromise = null;
    });
    const wrapped = this._installPromise;
    return wrapped;
  }

  enable() {
    const ticket = this._requestGeneration();
    return this._enqueue(async () => {
      const installed = await this.installer.verify();
      if (installed.state !== 'installed') {
        throw new ObserverLifecycleError('not_installed', 'Observer artifact is not installed and verified');
      }
      if (ticket !== this._requestedGeneration) throw new ObserverLifecycleError('operation_obsolete', 'Observer enable was superseded');
      await this._persist({ enabled: true, generation: ticket, teardownFence: false, removalState: null, lastError: null });
      return { ...installed, enabled: true, generation: ticket };
    });
  }

  disable({ reason = 'disabled' } = {}) {
    const ticket = this._requestGeneration();
    return this._enqueue(async () => {
      await this._persist({ enabled: false, generation: ticket, teardownFence: true, lastError: null });
      try {
        await this.teardown({ reason, generation: ticket });
        await this.reconcilePersisted();
      } catch (error) {
        let persistenceError;
        try {
          await this._persist({ enabled: false, generation: ticket, teardownFence: true, lastError: 'teardown_failed' });
        } catch (persistError) {
          persistenceError = persistError;
        }
        const lifecycleError = new ObserverLifecycleError(
          'teardown_failed', 'Observer teardown did not prove zero owned survivors', error,
        );
        lifecycleError.cleanupAttempted = true;
        if (persistenceError) lifecycleError.persistenceError = persistenceError;
        throw lifecycleError;
      }
      return { ...(await this.installer.verify()), enabled: false, generation: ticket };
    });
  }

  uninstall() {
    const ticket = this._requestGeneration();
    return this._enqueue(async () => {
      await this._persist({
        enabled: false,
        generation: ticket,
        teardownFence: true,
        removalState: 'pending',
        lastError: null,
      });
      let cleanupAttempted = false;
      try {
        cleanupAttempted = true;
        await this.teardown({ reason: 'uninstall', generation: ticket });
        await this.reconcilePersisted();
        const removed = await this.installer.removeInstalledArtifacts();
        await this._persist({
          enabled: false,
          generation: ticket,
          teardownFence: true,
          removalState: null,
          lastError: null,
        });
        return { ...removed, enabled: false, generation: ticket };
      } catch (error) {
        let persistenceError;
        try {
          await this._persist({
            enabled: false,
            generation: ticket,
            teardownFence: true,
            removalState: 'failed',
            lastError: 'removal_failed',
          });
        } catch (persistError) {
          persistenceError = persistError;
        }
        const lifecycleError = new ObserverLifecycleError(
          'removal_failed', 'Observer removal failed and remains durably fenced', error,
        );
        lifecycleError.cleanupAttempted = cleanupAttempted;
        if (persistenceError) lifecycleError.persistenceError = persistenceError;
        throw lifecycleError;
      }
    });
  }

  firstLease(context) {
    const ticket = this._requestedGeneration;
    return this._enqueue(async () => {
      const desired = await this._readDesired();
      if (!desired.enabled || desired.teardownFence || desired.generation !== ticket) {
        throw new ObserverLifecycleError('observer_disabled', 'Observer is disabled or fenced');
      }
      const installed = await this.installer.verify();
      if (installed.state !== 'installed') {
        throw new ObserverLifecycleError('artifact_unavailable', 'Observer artifact failed verification');
      }
      return this.start({ context, generation: ticket, binaryPath: installed.binaryPath });
    });
  }

  reconcileStartup() {
    return this._enqueue(async () => {
      const desired = await this._readDesired();
      this._requestedGeneration = Math.max(this._requestedGeneration, desired.generation);
      if (!desired.enabled || desired.teardownFence || desired.removalState) {
        await this.teardown({ reason: 'startup_reconcile', generation: desired.generation });
      }
      return this.status();
    });
  }
}
