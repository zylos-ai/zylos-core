import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRuntimeHeartbeatEnabled } from '../heartbeat-config.js';

describe('heartbeat-config', () => {
  it('disables claude heartbeat by default', () => {
    assert.equal(isRuntimeHeartbeatEnabled({ runtimeId: 'claude', config: {} }), false);
  });

  it('allows claude heartbeat when explicitly enabled', () => {
    assert.equal(
      isRuntimeHeartbeatEnabled({ runtimeId: 'claude', config: { heartbeat_enabled: 'true' } }),
      true
    );
  });

  it('accepts explicit boolean false for claude heartbeat', () => {
    assert.equal(
      isRuntimeHeartbeatEnabled({ runtimeId: 'claude', config: { heartbeat_enabled: false } }),
      false
    );
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
