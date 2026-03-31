import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContextMonitorBase } from '../runtime/context-monitor-base.js';

class FakeMonitor extends ContextMonitorBase {
  constructor(results, opts) {
    super(opts);
    this._results = Array.isArray(results) ? [...results] : [results];
  }

  async getUsage() {
    return this._results.shift() ?? null;
  }
}

describe('ContextMonitorBase.checkOnce', () => {
  it('fires onSessionChange when the runtime session id changes', async () => {
    const monitor = new FakeMonitor([
      { used: 10, ceiling: 100, sessionId: 'session-a' },
      { used: 15, ceiling: 100, sessionId: 'session-b' },
    ]);

    const seen = [];
    await monitor.checkOnce({
      onSessionChange: async (info) => {
        seen.push(info);
      },
    });
    await monitor.checkOnce({
      onSessionChange: async (info) => {
        seen.push(info);
      },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].previousSessionId, 'session-a');
    assert.equal(seen[0].sessionId, 'session-b');
    assert.equal(seen[0].used, 15);
  });

  it('retains checkThreshold backward compatibility', async () => {
    const monitor = new FakeMonitor({ used: 90, ceiling: 100, sessionId: 'session-a' }, { threshold: 0.75 });
    let called = false;

    await monitor.checkThreshold(async ({ ratio }) => {
      called = true;
      assert.equal(ratio, 0.9);
    });

    assert.equal(called, true);
  });
});
