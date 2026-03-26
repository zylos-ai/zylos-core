import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getInitialUsageCheckAt } from '../usage-check-init.js';

describe('usage-check-init', () => {
  it('forces codex to refresh immediately even with persisted state', () => {
    assert.equal(
      getInitialUsageCheckAt({
        runtimeId: 'codex',
        usageState: { lastCheckEpoch: 123 },
        nowEpoch: 999
      }),
      0
    );
  });

  it('starts codex fresh installs at zero so the first probe can run', () => {
    assert.equal(
      getInitialUsageCheckAt({
        runtimeId: 'codex',
        usageState: null,
        nowEpoch: 999
      }),
      0
    );
  });

  it('keeps claude fresh installs delayed by a full interval', () => {
    assert.equal(
      getInitialUsageCheckAt({
        runtimeId: 'claude',
        usageState: null,
        nowEpoch: 999
      }),
      999
    );
  });

  it('keeps persisted timestamp for claude restarts', () => {
    assert.equal(
      getInitialUsageCheckAt({
        runtimeId: 'claude',
        usageState: { lastCheckEpoch: 123 },
        nowEpoch: 999
      }),
      123
    );
  });
});
