import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildStatusPayload,
  publicHealth,
  readInitialStatus,
  writeStatus
} from '../status-writer.js';

function tempStatusFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-status-writer-')), 'agent-status.json');
}

describe('status-writer', () => {
  it('projects only sanitized terminal Hook metadata for ops consumers', () => {
    const hook = { event_id: 'failure:abc', event: 'stop_failure', error: 'rate_limit',
      observed_at: 1234, runtime_generation: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      session_id: 'PRIVATE_SESSION', prompt: 'PRIVATE_PROMPT', error_details: 'PRIVATE_ERROR' };
    const payload = buildStatusPayload({ statusObj: { state: 'busy' }, healthEngine: {
      health: 'rate_limited', evidence: { store: { runtime: 'claude', read: () => ({ episode: 2, revision: 4, runtime_generation: hook.runtime_generation, last_hook: hook }) } },
    } });
    assert.equal(payload.health_episode, 'claude:2');
    assert.equal(payload.health_revision, 4);
    assert.deepEqual(payload.last_hook, { event_id: hook.event_id, event: 'stop_failure',
      error: 'rate_limit', observed_at: 1234, runtime_generation: hook.runtime_generation });
    assert.doesNotMatch(JSON.stringify(payload), /PRIVATE/);
    hook.error = 'PRIVATE_TOKEN';
    assert.equal(buildStatusPayload({ statusObj: {}, healthEngine: {
      health: 'ok', evidence: { store: { runtime: 'claude', read: () => ({ runtime_generation: hook.runtime_generation, last_hook: hook }) } },
    } }).last_hook.error, 'unknown');
    assert.equal(buildStatusPayload({ statusObj: {}, healthEngine: {
      health: 'ok', evidence: { store: { runtime: 'claude', read: () => ({ runtime_generation: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', last_hook: hook }) } },
    } }).last_hook, undefined);
  });
  it('fails open to ok health when status file is missing or invalid', () => {
    const missingFile = tempStatusFile();
    assert.deepEqual(readInitialStatus({ statusFile: missingFile }), { health: 'ok' });

    fs.writeFileSync(missingFile, '{bad json');
    assert.deepEqual(readInitialStatus({ statusFile: missingFile }), { health: 'ok' });
  });

  it('reads existing health from status file', () => {
    const statusFile = tempStatusFile();
    fs.writeFileSync(statusFile, JSON.stringify({ health: 'recovering', reason: 'test' }));

    assert.deepEqual(readInitialStatus({ statusFile }), {
      health: 'recovering',
      reason: 'test',
    });
  });

  it('adds rate-limit and unavailable reason metadata', () => {
    const payload = buildStatusPayload({
      statusObj: { state: 'busy' },
      healthEngine: {
        health: 'rate_limited',
        rateLimitResetTime: '12:30',
        cooldownUntil: 1234,
        healthReason: 'rate_limit_detected',
      },
    });

    assert.deepEqual(payload, {
      state: 'busy',
      rate_limit_reset: '12:30',
      cooldown_until: 1234,
      unavailable_reason: 'rate_limit_detected',
      health: 'rate_limited',
    });
  });

  it('normalizes legacy internal health states before writing public status', () => {
    assert.equal(publicHealth('recovering'), 'unavailable');
    assert.equal(publicHealth('down'), 'unavailable');
    assert.equal(publicHealth('unavailable'), 'unavailable');

    const payload = buildStatusPayload({
      statusObj: { state: 'busy' },
      healthEngine: {
        health: 'recovering',
        healthReason: 'heartbeat_timeout',
        unavailableSince: 1234,
      },
    });

    assert.deepEqual(payload, {
      state: 'busy',
      unavailable_reason: 'heartbeat_timeout',
      unavailable_since: 1234,
      health: 'unavailable',
    });
  });

  it('writes status atomically to the target file', () => {
    const statusFile = tempStatusFile();
    const ok = writeStatus({
      statusFile,
      statusObj: { state: 'idle' },
      healthEngine: { health: 'ok', healthReason: null },
    });

    assert.equal(ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(statusFile, 'utf8')), {
      state: 'idle',
      health: 'ok',
    });
  });
});
