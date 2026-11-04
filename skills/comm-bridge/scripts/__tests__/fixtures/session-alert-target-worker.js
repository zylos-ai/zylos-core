import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { emitC4Conversations } from '../../c4-session-init.js';

// Scope and delivered history are inputs; reading the real isolated F1 is the
// behavior under test. Neither production C4 nor tmux should be loaded here.
mock.module('../../c4-db.js', { namedExports: {} });
mock.module('../../../../../cli/lib/runtime/tmux-connection.js', {
  namedExports: { openTmuxConnection: () => assert.fail('alert context must not connect to tmux') },
});
const input = JSON.parse(process.argv[2]);
const mode = input.mode ?? 'single';
const group = input.group ?? 'origin';
const scope = { mode, scope: mode === 'single' ? '*' : group,
  sessionGroup: mode === 'single' ? null : group, root: process.env.ZYLOS_DIR,
  memoryDir: `${process.env.ZYLOS_DIR}/memory` };
const calls = [];
const db = {
  getCoverageEnd: () => { calls.push('coverage'); return 0; },
  getGlobalCoverageEnd: () => { calls.push('coverage'); return 0; },
  getDeliveredSince: () => { calls.push('tail'); return input.rows ?? []; },
  getGlobalDeliveredSince: () => { calls.push('tail'); return input.rows ?? []; },
  formatConversationsForAgent: rows => rows.map(row => row.content).join('\n'),
};
const output = await emitC4Conversations(input.payload ?? {}, input.budget ?? null, {
  scopeReader: async () => scope,
  migrationReader: async () => ({ state: 'done' }),
  withDb: async (_label, action) => action(db),
});
assert.deepEqual(calls, ['coverage', 'tail']);
process.stdout.write(JSON.stringify({ output }));
