import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { schedulerQueryFixture } from './helpers/scheduler-query-fixture.js';
import { dispatchTask } from '../skills/scheduler/scripts/daemon-dispatch.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';
import { deliveryFixture } from '../skills/comm-bridge/scripts/__tests__/helpers/session-delivery-fixture.js';

// Real task dispatch, receiver process, C4 store and delivery policy. Terminal
// I/O is local fixture code; no runtime, service or platform is contacted.
// Run both health cases for scheduler ingress, delivery attribution or health
// routing changes; skip unrelated scheduler/UI changes. The fixture reads back
// private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, databases and AM socket before
// dispatch, uses no tmux socket, and closes databases/removes its root on exit.
for (const health of ['ok', 'auth_failed']) test(`single scheduled delivery retains task routing with ${health} health`, async t => {
  const f = schedulerQueryFixture(t);
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'single' }));
  const task = f.legacy({ session_component: 'telegram', session_group_name: 'team' });
  assert.equal(dispatchTask(f.db, task, f.deps).claimed, true);
  const store = createStore(f.c4, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'single' } }) });
  const row = store.getNextPending({ sessionMode: 'single' });
  assert.equal(row.session_group, 'telegram:team');
  assert.equal(store.claimConversation(row.id, { sessionMode: 'single' }), true);
  const delivery = deliveryFixture(t, { mode: 'single', health, storage: { db: f.c4, store } });
  const result = await delivery.delivery.deliverConversation(row);
  const saved = f.c4.prepare('SELECT * FROM conversations WHERE id=?').get(row.id);
  assert.equal(saved.status, health === 'ok' ? 'delivered' : 'pending');
  assert.equal(saved.session_group, health === 'ok' ? 'origin' : 'telegram:team');
  assert.equal(result.blocked, health !== 'ok');
  if (health === 'ok') assert.ok(delivery.calls.some(call => call[0] === 'paste' && call[1] === 'origin'));
  else assert.equal(delivery.calls.length, 0);
  const savedTask = f.read(task.id);
  assert.equal(savedTask.session_component, 'telegram');
  assert.equal(savedTask.session_group_name, 'team');
});
