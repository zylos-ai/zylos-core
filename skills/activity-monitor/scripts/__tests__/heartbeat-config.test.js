import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRuntimeHeartbeatEnabled } from '../heartbeat-config.js';

describe('heartbeat-config', () => {
  it('keeps claude heartbeat enabled by default', () => {
    assert.equal(isRuntimeHeartbeatEnabled({ runtimeId: 'claude', config: {} }), true);
  });

  it('disables codex heartbeat by default', () => {
    assert.equal(isRuntimeHeartbeatEnabled({ runtimeId: 'codex', config: {} }), false);
  });

  it('allows codex heartbeat when explicitly enabled', () => {
    assert.equal(
      isRuntimeHeartbeatEnabled({ runtimeId: 'codex', config: { codex_heartbeat_enabled: 'true' } }),
      true
    );
  });

  it('accepts explicit boolean false for codex heartbeat', () => {
    assert.equal(
      isRuntimeHeartbeatEnabled({ runtimeId: 'codex', config: { codex_heartbeat_enabled: false } }),
      false
    );
  });
});
