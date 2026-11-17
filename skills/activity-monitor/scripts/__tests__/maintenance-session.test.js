import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueStartupPrompt } from '../session-start-prompt.js';
import { maintenanceSyncPrompt, maintenanceSessionContext, claimMaintenanceStartup, readMaintenanceSession } from '../maintenance-session.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMaintenanceRequests } from '../../../../cli/lib/sync-maintenance.js';

test('maintenance startup enqueues one Sync with a fifteen minute acknowledgment deadline', async () => {
  const calls = [];
  const result = await enqueueStartupPrompt('startup', {
    onboardingPending: () => false,
    maintenanceReader: () => ({ runId: 'maintenance-run' }),
    startupClaimer: () => ({ runId: 'maintenance-run' }),
    scopeReader: async () => ({ sessionGroup: 'inactive-group' }),
    migrationPending: () => assert.fail('maintenance does not perform migration'),
    recentReader: () => assert.fail('maintenance does not look for waiting humans'),
    execFile: async (...args) => { calls.push(args); return { stdout: '{"ok":true,"id":12}' }; },
  });
  assert.equal(result.startupControlIds[0], 12); assert.equal(calls.length, 1);
  const args = calls[0][1];
  assert.equal(args[args.indexOf('--content') + 1], maintenanceSyncPrompt);
  assert.equal(args[args.indexOf('--ack-deadline') + 1], '900');
  // READY publishes these startup ids for the exact run after enqueue returns.
  // A target binding cannot be built before that READY publication.
  assert.equal(args.includes('--target-run'), false);
  assert.equal(args.includes('--no-ack-suffix'), false);
  assert.match(maintenanceSyncPrompt, /exactly one group Memory Sync/);
  assert.match(maintenanceSyncPrompt, /Do not resume handoff work/);
  assert.match(maintenanceSyncPrompt, /reply to any channel/);
  assert.match(maintenanceSyncPrompt, /checkpoint already exists/);
});

// Real durable maintenance ledger and startup producer, private filesystem;
// enqueue is an injected transport, no runtime/tmux/PM2/channel or live DB.
// Run for startup claim/retry changes; unrelated prompt text may skip.
test('maintenance startup and clear share one durable startup reservation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ZYLOS_DIR: root, ZYLOS_SESSION_GROUP: 'quiet', ZYLOS_RUN_ID: 'maintenance-run' };
  const requests = createMaintenanceRequests({ env });
  await requests.queue({ sessionGroup: 'quiet', reason: 'inactive_lag', target: { end: 0 } });
  await requests.claimMaintenance('quiet', env.ZYLOS_RUN_ID);
  let enqueued = 0;
  const options = {
    onboardingPending: () => false, scopeReader: async () => ({ sessionGroup: 'quiet' }),
    maintenanceReader: () => readMaintenanceSession(env),
    startupClaimer: maintenance => claimMaintenanceStartup(maintenance, env),
    recentReader: () => assert.fail('maintenance must not resume ordinary work'),
    migrationPending: () => assert.fail('maintenance must not resume migrations'),
    execFile: async () => { enqueued++; return { stdout: '{"ok":true,"id":12}' }; },
  };
  assert.equal((await enqueueStartupPrompt('startup', options)).skipped, false);
  for (const source of ['startup', 'clear', 'clear']) {
    const result = await enqueueStartupPrompt(source, options);
    assert.equal(result.reason, 'maintenance_started'); assert.equal(result.startupControlIds.length, 0);
  }
  assert.equal(enqueued, 1);
  assert.equal(createMaintenanceRequests({ env }).read()[0].startupClaimed, true);
  assert.match(maintenanceSessionContext, /Wait for the maintenance startup control/);
  assert.match(maintenanceSessionContext, /not a second Sync request/);
});

test('failed maintenance enqueue retains its startup reservation across clear', async () => {
  let claimed = false, enqueued = 0;
  const options = {
    onboardingPending: () => false, scopeReader: async () => ({ sessionGroup: 'quiet' }),
    maintenanceReader: () => ({ runId: 'maintenance-run' }),
    startupClaimer: () => { if (claimed) return null; claimed = true; return {}; },
    execFile: async () => { enqueued++; throw new Error('enqueue unavailable'); },
  };
  await assert.rejects(enqueueStartupPrompt('startup', options), /enqueue unavailable/);
  assert.equal((await enqueueStartupPrompt('clear', options)).reason, 'maintenance_started');
  assert.equal(enqueued, 1);
});

for (const failureAt of ['read', 'claim']) test(`unreadable maintenance ledger during startup ${failureAt} preserves ordinary startup`, async () => {
  let ordinaryChecks = 0;
  const unavailable = () => { throw Object.assign(new Error('unreadable ledger'), { code: 'SYNC_MAINTENANCE_UNREADABLE' }); };
  const result = await enqueueStartupPrompt('startup', {
    onboardingPending: () => false,
    scopeReader: async () => ({ sessionGroup: 'quiet' }),
    maintenanceReader: failureAt === 'read' ? unavailable : () => ({ runId: 'maintenance-run' }),
    startupClaimer: unavailable,
    migrationPending: () => false,
    recentReader: () => { ordinaryChecks++; return null; },
  });
  assert.equal(result.reason, 'nothing_pending');
  assert.equal(ordinaryChecks, 1);
});
