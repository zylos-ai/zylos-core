import { getInitialUsageCheckAt } from '../usage-check-init.js';

describe('usage-check-init', () => {
  test('uses persisted timestamp when present', () => {
    expect(
      getInitialUsageCheckAt({
        runtimeId: 'codex',
        usageState: { lastCheckEpoch: 123 },
        nowEpoch: 999
      })
    ).toBe(123);
  });

  test('starts codex fresh installs at zero so the first probe can run', () => {
    expect(
      getInitialUsageCheckAt({
        runtimeId: 'codex',
        usageState: null,
        nowEpoch: 999
      })
    ).toBe(0);
  });

  test('keeps claude fresh installs delayed by a full interval', () => {
    expect(
      getInitialUsageCheckAt({
        runtimeId: 'claude',
        usageState: null,
        nowEpoch: 999
      })
    ).toBe(999);
  });
});
