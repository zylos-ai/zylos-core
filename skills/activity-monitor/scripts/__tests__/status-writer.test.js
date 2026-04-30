import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildStatusPayload,
  readInitialStatus,
  writeStatus
} from '../status-writer.js';

function tempStatusFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-status-writer-')), 'agent-status.json');
}

describe('status-writer', () => {
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
