import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { singletonFixture, waitFor } from './helpers/dispatcher-singleton.js';

// Singleton contract: real PM2 7.0.4 and production main/factory, database,
// scheduler, recovery and guarded tmux delivery; only the model/health boundary
// is synthetic. Requires Linux /proc, tmux >=3.2a with new-session -e, SQLite
// dependencies and PM2 7.0.4. No model API, network or live service is used.
// Run after ownership, PM2 startup/shutdown or recovery changes:
// ZYLOS_DISPATCHER_INTEGRATION=1 node scripts/run-node-tests.js test/dispatcher-singleton.integration.test.js
// Other changes may skip; the normal runner discovers and reports gated skips.
// Each fixture proves environment/socket isolation before starting PM2 and
// reclaims every marked /proc process, including unmanaged restart survivors.
const enabled = process.env.ZYLOS_DISPATCHER_INTEGRATION === '1';
const options = { skip: !enabled, timeout: 120_000 };

// Deterministic form of PM2's double-stop callback: its tracked child is alive,
// but the pidfile disappears before the child can acquire ownership.
test('PM2 tracked child admits when a late stop callback removed its pidfile', options, async t => {
  const f = await singletonFixture(t);
  await f.pm('start', f.config('v1', { admissionBarrier: true }));
  const tracked = JSON.parse(await f.pm('jlist')).find(row => row.name === 'c4-dispatcher');
  assert.ok(tracked.pid > 0);
  const pidfile = tracked.pm2_env.pm_pid_path;
  assert.ok(pidfile.startsWith(path.join(f.root, 'pm2') + path.sep));
  fs.rmSync(pidfile, { force: true });
  fs.writeFileSync(path.join(f.root, 'admit'), 'ready');
  assert.equal((await f.managedOwner('v1')).pid, tracked.pid);
  const token = 'MISSING_PIDFILE_TOKEN', row = f.enqueue(token);
  await f.delivered(row, token); await f.settle(); await f.lockHeld();
});

for (const mode of ['single', 'multi']) {
  for (const ps of [true, false]) {
    // Covers the procps regression in both routing modes, three consecutive
    // restarts, input concurrent with restart and later steady-state input.
    test(`${mode}, ${ps ? 'with ps' : 'without ps'}: three PM2 restarts preserve one owner and one paste per input`, options, async t => {
      const f = await singletonFixture(t, { mode, ps });
      await f.pm('start', f.config('v1'));
      await f.managedOwner('v1'); await f.lockHeld();
      const rows = [];
      for (let round = 0; round < 3; round++) {
        const token = `RESTART_${mode}_${ps}_${round}_TOKEN`;
        const restart = f.pm('restart', 'c4-dispatcher');
        const row = f.enqueue(token); rows.push([row, token]);
        await restart; await f.managedOwner('v1');
        await f.delivered(row, token); await f.lockHeld();
      }
      const token = `STEADY_${mode}_${ps}_TOKEN`, row = f.enqueue(token);
      rows.push([row, token]); await f.delivered(row, token);
      await f.settle();
      for (const [, value] of rows) assert.equal(f.count(value), 1);
      console.log('Restart singleton proof:', JSON.stringify({ mode, ps, restarts: 3, tokens: rows.length, owner: await f.managedOwner() }));
    });
  }

  // Covers kernel lock release after SIGKILL, pending backlog, and actual
  // claimed-row startup recovery. Killing after paste cannot promise exactly
  // once (terminal I/O and SQLite settlement are not an atomic transaction).
  test(`${mode}: SIGKILL owner releases lifetime lock and replacement recovers a claimed backlog`, options, async t => {
    const f = await singletonFixture(t, { mode });
    await f.pm('start', f.config('v1', { autorestart: true }));
    const old = await f.managedOwner(); await f.lockHeld();
    process.kill(old.pid, 'SIGSTOP');
    const tokens = Array.from({ length: 3 }, (_, index) => `KILL_${mode}_${index}_TOKEN`);
    const rows = tokens.map(token => f.enqueue(token));
    assert.equal(f.store.claimConversation(rows[0].id), true);
    process.kill(old.pid, 'SIGKILL');
    await waitFor(() => !f.processes().some(row => row.pid === old.pid), 'killed owner disappearance');
    const next = await f.managedOwner(); assert.notEqual(next.pid, old.pid);
    await f.lockHeld();
    for (let index = 0; index < rows.length; index++) await f.delivered(rows[index], tokens[index]);
    await f.settle();
    for (const token of tokens) assert.equal(f.count(token), 1);
  });

  // PM2 restarts one stable fixture entry, which selects immutable v1/v2
  // wrappers from fixture configuration. Product files are never rewritten.
  test(`${mode}: no-ps PM2 deployment replaces v1 with v2 and delivers each token once`, options, async t => {
    const f = await singletonFixture(t, { mode });
    await f.pm('start', f.config('v1'));
    const old = await f.managedOwner('v1'); await f.lockHeld();
    const beforeToken = `BASELINE_${mode}_TOKEN`, before = f.enqueue(beforeToken);
    await f.delivered(before, beforeToken);
    f.config('v2');
    const restart = f.pm('restart', 'c4-dispatcher');
    const token = `UPGRADE_${mode}_TOKEN`, row = f.enqueue(token);
    await restart;
    const next = await f.managedOwner('v2'); assert.notEqual(next.pid, old.pid);
    await f.delivered(row, token);
    const afterToken = `FOLLOWUP_${mode}_TOKEN`, after = f.enqueue(afterToken);
    await f.delivered(after, afterToken); await f.settle(); await f.lockHeld();
    assert.equal(f.count(token), 1); assert.equal(f.count(beforeToken), 1); assert.equal(f.count(afterToken), 1);
    assert.ok(f.events().some(event => event.type === 'pasted' && event.conversationId === after.id && event.pid === next.pid && event.version === 'v2'), 'Replacement version owns the follow-up terminal paste');
  });
}

// Standalone contenders have no PM2 pidfile; they must wait for kernel lock
// ownership rather than removing the lock file or treating a PID as authority.
test('standalone contenders wait, admit only after release, and leave the same lock usable', options, async t => {
  const f = await singletonFixture(t);
  const first = f.standalone('v1'); await f.owner('v1'); await f.lockHeld();
  process.kill(first.pid, 'SIGSTOP');
  const token = 'STANDALONE_HANDOFF_TOKEN', row = f.enqueue(token);
  assert.equal(f.store.claimConversation(row.id), true);
  const second = f.standalone('v2');
  await delay(350); assert.equal((await f.owner()).pid, first.pid);
  assert.equal(f.events().some(row => row.type === 'create' && row.pid === second.pid), false);
  assert.equal(f.database.prepare('SELECT status FROM conversations WHERE id=?').get(row.id).status, 'running');
  assert.equal(f.count(token), 0, 'A contender must not recover an incumbent running row');
  process.kill(first.pid, 'SIGCONT');
  process.kill(first.pid, 'SIGTERM');
  assert.equal((await f.owner('v2')).pid, second.pid);
  await f.delivered(row, token); await f.settle(); await f.lockHeld();
});
