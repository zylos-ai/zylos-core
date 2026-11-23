import test from 'node:test';
import assert from 'node:assert/strict';
import { readSessionModeStatus } from '../session-mode-status.js';

const row = { run_id: 'switch-a', source_mode: 'single', target_mode: 'multi', phase: 'gating', cutoff: null,
  reason: 'running_control_without_deadline:machine:17', created_at: 100, updated_at: 102 };
const defaults = overrides => ({
  db: { getModeTransition: () => row, getDrainFence: group => { assert.equal(group, '*'); return { reason: null, runId: null }; }, getLastCompletedModeTransition: () => null },
  readMode: () => ({ mode: 'single', keyPresent: true }), readEvents: () => [], probeSupervisor: () => true,
  readPm2: () => { throw new Error('reachable socket must not query PM2'); }, ...overrides,
});

for (const method of ['getModeTransition', 'getDrainFence', 'getLastCompletedModeTransition']) {
  test(`${method} failures propagate instead of becoming absent`, async () => {
    const input = defaults(); const failure = Object.assign(new Error('held database'), { code: 'DB_BUSY', persisted: [] });
    input.db[method] = () => { throw failure; };
    input.probeSupervisor = () => { throw new Error('must stop before observations'); };
    await assert.rejects(readSessionModeStatus(input), error => error === failure);
  });
}
