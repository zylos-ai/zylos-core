import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Guardian } from '../guardian.js';

function createAdapter(overrides = {}) {
  const calls = {
    clearStaleState: 0,
    enqueueStartupPrompt: 0,
    launch: 0,
    isRunning: 0,
  };

  const adapter = {
    sessionName: 'test-main',
    displayName: 'TestRuntime',
    isRunning: async () => {
      calls.isRunning++;
      return overrides.isRunning ?? false;
    },
    launch: async () => {
      calls.launch++;
    },
    clearStaleState: () => {
      calls.clearStaleState++;
    },
    enqueueStartupPrompt: () => {
      calls.enqueueStartupPrompt++;
    },
  };

  return { adapter, calls };
}

function createDeps(overrides = {}) {
  const calls = {
    log: [],
    resetToolLifecycleState: 0,
  };

  const deps = {
    log: (message) => calls.log.push(message),
    resetToolLifecycleState: () => {
      calls.resetToolLifecycleState++;
    },
    execSyncImpl: overrides.execSyncImpl ?? (() => {
      throw new Error('no session');
    }),
    nowMs: overrides.nowMs ?? (() => 100_000),
    initialRuntimeLaunchAtMs: overrides.initialRuntimeLaunchAtMs ?? 0,
  };

  return { deps, calls };
}

describe('Guardian', () => {
  it('starts the runtime after the offline restart delay without reading health state', async () => {
    const { adapter, calls } = createAdapter();
    const { deps, calls: depCalls } = createDeps();
    const guardian = new Guardian(adapter, deps);

    let result;
    for (let i = 1; i <= 5; i++) {
      result = await guardian.tick({ currentTime: i });
    }

    assert.equal(result.state, 'offline');
    assert.equal(result.attempted_restart, true);
    assert.equal(result.runtimeLaunchAtMs, 100_000);
    assert.equal(calls.launch, 1);
    assert.equal(calls.clearStaleState, 1);
    assert.equal(calls.enqueueStartupPrompt, 1);
    assert.equal(depCalls.resetToolLifecycleState, 1);
  });

  it('uses startup grace after a launch attempt', async () => {
    const { adapter } = createAdapter();
    const { deps } = createDeps();
    const guardian = new Guardian(adapter, deps);

    for (let i = 1; i <= 5; i++) {
      await guardian.tick({ currentTime: i });
    }

    const result = await guardian.tick({ currentTime: 6 });

    assert.equal(result.state, 'offline');
    assert.equal(result.attempted_restart, false);
    assert.equal(result.skippedForStartupGrace, true);
    assert.equal(guardian.getState().startupGrace, 29);
  });

  it('reports stopped when tmux exists but the runtime process is not running', async () => {
    const { adapter } = createAdapter({ isRunning: false });
    const { deps } = createDeps({
      execSyncImpl: () => '',
    });
    const guardian = new Guardian(adapter, deps);

    const result = await guardian.tick({ currentTime: 1 });

    assert.equal(result.state, 'stopped');
    assert.equal(result.message, 'TestRuntime not running in tmux');
    assert.equal(result.notRunningSeconds, 1);
  });

  it('resets restart backoff after stable running time', async () => {
    const { adapter } = createAdapter({ isRunning: true });
    const { deps } = createDeps({
      execSyncImpl: (command) => {
        if (command.startsWith('tmux has-session')) return '';
        throw new Error(`unexpected command: ${command}`);
      },
    });
    const guardian = new Guardian(adapter, deps);

    guardian.startAgent();
    assert.equal(guardian.getState().consecutiveRestarts, 1);

    await guardian.tick({ currentTime: 10 });
    assert.equal(guardian.getState().consecutiveRestarts, 1);

    const result = await guardian.tick({ currentTime: 70 });

    assert.equal(result.state, 'running');
    assert.equal(guardian.getState().consecutiveRestarts, 0);
    assert.equal(guardian.getState().stableRunningSince, 0);
  });

  it('prepares instructions before launch and does not launch on preparation failure', async () => {
    const order = [];
    let rejectPreparation;
    const adapter = {
      sessionName: 'test-main',
      displayName: 'TestRuntime',
      buildInstructionFile: () => new Promise((resolve, reject) => {
        rejectPreparation = reject;
        order.push('prepare');
      }),
      launch: async () => { order.push('launch'); },
      clearStaleState: () => {},
      enqueueStartupPrompt: () => { order.push('prompt'); },
    };
    const { deps, calls } = createDeps();
    const guardian = new Guardian(adapter, deps);
    assert.equal(guardian.startAgent(), true);
    assert.deepEqual(order, ['prepare']);
    rejectPreparation(new Error('assembly failed'));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ['prepare']);
    assert.ok(calls.log.some(message => message.includes('assembly failed')));
  });

  it('launches only after asynchronous instruction preparation resolves', async () => {
    const order = [];
    let resolvePreparation;
    const adapter = {
      sessionName: 'test-main',
      displayName: 'TestRuntime',
      buildInstructionFile: () => new Promise(resolve => {
        resolvePreparation = resolve;
        order.push('prepare');
      }),
      launch: async () => { order.push('launch'); },
      clearStaleState: () => {},
      enqueueStartupPrompt: () => { order.push('prompt'); },
    };
    const { deps } = createDeps();
    const guardian = new Guardian(adapter, deps);
    guardian.startAgent();
    assert.deepEqual(order, ['prepare']);
    resolvePreparation();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ['prepare', 'launch', 'prompt']);
  });
});
