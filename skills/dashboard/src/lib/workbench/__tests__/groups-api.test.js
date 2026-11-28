import assert from 'node:assert/strict';
import test from 'node:test';
import { workingText } from '../../../../public/js/wb/working-display.js';
import { snapshotWorking } from '../../chat/activity.js';
import { projectGroup } from '../groups-api.js';

test('the running group list follows the conversation header when the monitor is busy', async () => {
  const row = {
    sessionGroup: 'telegram:fixture',
    presence: 'running',
    working: { on: false },
    live: { status: { valid: true, state: 'busy' } },
  };
  const readAt = Date.parse('2026-11-28T00:00:00Z');
  const snapshot = { rows: [row], readAt, listKnown: true, sources: { status: { ok: true, readAt } } };
  const readHeader = snapshotWorking({ getSnapshot: async () => snapshot, hotTtlMs: () => 60_000 }, { origin: 'origin' });
  const header = await readHeader(row.sessionGroup);
  const group = projectGroup(row, snapshot);

  assert.equal(header.presence, 'running');
  assert.equal(workingText(header.working), 'wb.state.idle');
  assert.equal(workingText(header.working), `wb.state.${group.state.kind}`);
  assert.equal(group.mainAgent, 'busy');
});
