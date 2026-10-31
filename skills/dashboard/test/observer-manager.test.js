import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ObserverCoordinator } from '../src/lib/observer-coordinator.js';
import { ObserverManager } from '../src/lib/observer-manager.js';

function context(principalId, credentialId = `${principalId}-session`) {
  const value = { kind: 'api', principalId, scope: 'admin' };
  Object.defineProperty(value, 'credentialId', { value: credentialId, enumerable: false });
  return value;
}

function fixture(overrides = {}) {
  let now = 1_000;
  let starts = 0;
  let stops = 0;
  const containment = {
    active: null,
    async stopGeneration() { stops += 1; this.active = null; return { stopped: true }; },
  };
  const coordinator = {
    async firstLease() {
      starts += 1;
      containment.active = { generation: 5 };
      return containment.active;
    },
    async disable() { await containment.stopGeneration(); return { enabled: false }; },
    async uninstall() { await containment.stopGeneration(); return { state: 'not_installed' }; },
  };
  const validCredentials = new Set(['admin-session', 'admin-refreshed', 'other-session']);
  const authGate = {
    revalidateAuthContext(value) {
      return validCredentials.has(value.credentialId) ? value : null;
    },
  };
  const manager = new ObserverManager({
    coordinator, containment, authGate, runtime: 'codex',
    now: () => now, idleGraceMs: 10, revalidateMs: 60_000, ...overrides,
  });
  return {
    manager, containment, coordinator, authGate, validCredentials,
    advance(ms) { now += ms; },
    counts() { return { starts, stops }; },
  };
}

test('leases coalesce first start and bind principal, target, and generation', async () => {
  const f = fixture();
  const admin = context('admin');
  const [first, second] = await Promise.all([
    f.manager.createLease(admin),
    f.manager.createLease(admin),
  ]);
  assert.equal(f.counts().starts, 1);
  assert.notEqual(first.id, second.id);
  assert.equal(first.generation, 5);
  assert.equal(f.manager.validateLease(first.id, context('admin', 'admin-refreshed')).id, first.id,
    'same stable key principal may refresh its API session');
  assert.throws(() => f.manager.validateLease(first.id, context('other')), (error) => error?.code === 'lease_mismatch');
  assert.throws(() => f.manager.validateLease(first.id, admin, { target: 'remote' }), (error) => error?.code === 'lease_mismatch');
});

test('lease capacity, renewal, and expiry fail closed', async () => {
  const f = fixture({ maxViewers: 1, leaseTtlMs: 30 });
  const admin = context('admin');
  const lease = await f.manager.createLease(admin);
  await assert.rejects(f.manager.createLease(admin), (error) => error?.code === 'capacity_exceeded');
  assert.equal('preset' in lease, false);
  assert.equal('presets' in lease, false);
  assert.equal(f.manager.setPreset, undefined);
  f.advance(20);
  assert.equal(f.manager.renewLease(lease.id, admin).expiresAt, 1_050);
  f.advance(31);
  assert.throws(() => f.manager.validateLease(lease.id, admin), (error) => error?.code === 'lease_expired');
  assert.ok(await f.manager.createLease(admin), 'an expired lease must not consume reserved capacity');
});

test('concurrent lease reservations cannot exceed capacity', async () => {
  const f = fixture({ maxViewers: 1 });
  const attempts = await Promise.allSettled([
    f.manager.createLease(context('admin')),
    f.manager.createLease(context('admin')),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'capacity_exceeded');
});

test('pending leases prevent idle teardown while the first generation is still starting', async () => {
  let finishStart;
  const f = fixture({ idleGraceMs: 5 });
  f.coordinator.firstLease = () => {
    f.containment.active = { generation: 5 };
    return new Promise((resolve) => {
      finishStart = () => resolve(f.containment.active);
    });
  };

  const first = f.manager.createLease(context('admin'));
  await new Promise((resolve) => setImmediate(resolve));
  const second = f.manager.createLease(context('admin'));
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(f.counts().stops, 0);
  finishStart();
  const leases = await Promise.all([first, second]);
  assert.equal(leases.length, 2);
  assert.equal(f.manager.leases.size, 2);
  assert.equal(f.counts().stops, 0);
});

test('shutdown waits for an in-flight first lease start and tears down its generation', async () => {
  let finishStart;
  const f = fixture();
  f.coordinator.firstLease = () => new Promise((resolve) => {
    finishStart = () => {
      f.containment.active = { generation: 5 };
      resolve(f.containment.active);
    };
  });

  const lease = f.manager.createLease(context('admin'));
  await new Promise((resolve) => setImmediate(resolve));
  let shutdownFinished = false;
  const shutdown = f.manager.shutdown().then((result) => {
    shutdownFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownFinished, false);

  finishStart();
  await assert.rejects(lease, (error) => error?.code === 'operation_obsolete');
  await shutdown;
  assert.equal(f.counts().stops, 1);
  assert.equal(f.containment.active, null);
  assert.equal(f.manager.generation, null);
  assert.equal(f.manager._revalidationTimer, null);
  await assert.rejects(f.manager.createLease(context('admin')), (error) => error?.code === 'operation_obsolete');
});

test('10-second policy revalidation revokes a lease and last lease stops after grace', async () => {
  const f = fixture();
  const admin = context('admin');
  const lease = await f.manager.createLease(admin);
  f.validCredentials.delete('admin-session');
  assert.equal(await f.manager.revalidate(), 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.counts().stops, 1);
  assert.throws(() => f.manager.validateLease(lease.id, admin), (error) => error?.code === 'lease_not_found');
});

test('disable invalidates every lease before entering lifecycle teardown', async () => {
  const f = fixture();
  const lease = await f.manager.createLease(context('admin'));
  const result = await f.manager.invalidateAndDisable();
  assert.equal(result.enabled, false);
  assert.equal(f.manager.leases.size, 0);
  assert.equal(f.manager.generation, null);
  assert.throws(() => f.manager.validateLease(lease.id, context('admin')), (error) => error?.code === 'lease_not_found');
});

for (const action of ['disable', 'uninstall']) {
  test(`${action} waits for an in-flight first lease start before teardown`, async () => {
    let finishStart;
    const f = fixture();
    f.coordinator.firstLease = () => new Promise((resolve) => {
      finishStart = () => {
        f.containment.active = { generation: 5 };
        resolve(f.containment.active);
      };
    });

    const lease = f.manager.createLease(context('admin'));
    await new Promise((resolve) => setImmediate(resolve));
    let lifecycleFinished = false;
    const lifecycle = (action === 'disable'
      ? f.manager.invalidateAndDisable()
      : f.manager.invalidateAndUninstall()).then((result) => {
      lifecycleFinished = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lifecycleFinished, false);
    await assert.rejects(f.manager.createLease(context('admin')), (error) => error?.code === 'operation_obsolete');

    finishStart();
    await assert.rejects(lease, (error) => error?.code === 'operation_obsolete');
    await lifecycle;
    assert.equal(f.counts().stops, 1);
    assert.equal(f.containment.active, null);
    assert.equal(f.manager.generation, null);
    assert.equal(f.manager._revalidationTimer, null);
  });
}

for (const action of ['disable', 'uninstall']) {
  test(`${action} preserves teardown and fencing persistence failures without a second cleanup`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `observer-manager-dual-failure-${action}-`));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, `${JSON.stringify({ observer: { enabled: true, generation: 1 } })}\n`);
    let stops = 0;
    const cleanupError = Object.assign(new Error('cleanup deadline'), { code: 'cleanup_timeout' });
    const containment = {
      active: { generation: 1 },
      async stopGeneration() {
        stops += 1;
        fs.writeFileSync(configPath, '{invalid json');
        throw cleanupError;
      },
    };
    const coordinator = new ObserverCoordinator({
      configPath,
      installer: {
        async verify() { return { state: 'installed' }; },
        async removeInstalledArtifacts() { throw new Error('must not remove'); },
      },
      teardown: (options) => containment.stopGeneration(options),
    });
    const manager = new ObserverManager({
      coordinator, containment, authGate: { revalidateAuthContext: (value) => value },
    });
    manager.generation = 1;

    await assert.rejects(
      action === 'disable' ? manager.invalidateAndDisable() : manager.invalidateAndUninstall(),
      (error) => {
        assert.equal(error.cleanupAttempted, true);
        assert.equal(error.cause, cleanupError);
        assert.equal(error.persistenceError?.code, 'invalid_config');
        return true;
      },
    );
    assert.equal(stops, 1);
    assert.equal(manager._runtimeError, cleanupError);
    assert.equal(containment.active?.generation, 1);
  });
}

for (const action of ['disable', 'uninstall']) {
  test(`${action} preserves config failure but still tears down the revoked generation`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `observer-manager-${action}-`));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, `${JSON.stringify({ observer: { enabled: true, generation: 0 } })}\n`);
    let stops = 0;
    const containment = {
      active: null,
      async stopGeneration() {
        stops += 1;
        this.active = null;
        return { stopped: true };
      },
    };
    const installer = {
      async verify() { return { state: 'installed', binaryPath: '/fixture/zellij' }; },
      async removeInstalledArtifacts() { throw new Error('must not remove after persistence failure'); },
    };
    const coordinator = new ObserverCoordinator({
      configPath,
      installer,
      start: async ({ generation }) => {
        containment.active = { generation };
        return containment.active;
      },
      teardown: ({ reason }) => containment.stopGeneration({ reason }),
    });
    const manager = new ObserverManager({
      coordinator,
      containment,
      authGate: { revalidateAuthContext: (value) => value },
      runtime: 'codex',
      idleGraceMs: 5,
      revalidateMs: 60_000,
    });
    await manager.createLease(context('admin'));
    fs.writeFileSync(configPath, '{invalid json');

    const operation = action === 'disable'
      ? manager.invalidateAndDisable()
      : manager.invalidateAndUninstall();
    await assert.rejects(operation, (error) => error?.code === 'invalid_config');
    assert.equal(containment.active, null);
    assert.equal(manager.leases.size, 0);
    assert.equal(manager._idleTimer, null);
    assert.equal(manager._revalidationTimer, null);
    assert.equal(manager.generation, null);
    assert.equal(stops, 1);
  });
}

test('lifecycle persistence error remains primary while cleanup failure stays visible', async () => {
  const persistenceError = Object.assign(new Error('invalid config'), { code: 'invalid_config' });
  const cleanupError = Object.assign(new Error('owned survivors'), { code: 'owned_survivors' });
  const f = fixture();
  f.coordinator.disable = async () => { throw persistenceError; };
  f.containment.active = { generation: 5 };
  f.containment.stopGeneration = async () => { throw cleanupError; };
  f.manager.generation = 5;

  await assert.rejects(f.manager.invalidateAndDisable(), (error) => {
    assert.equal(error, persistenceError);
    assert.equal(error.cleanupError, cleanupError);
    return true;
  });
  assert.equal(f.manager._runtimeError, cleanupError);
});

for (const action of ['disable', 'uninstall']) {
  test(`${action} does not start a second cleanup after coordinator teardown was attempted`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `observer-manager-single-cleanup-${action}-`));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, `${JSON.stringify({ observer: { enabled: true, generation: 1 } })}\n`);
    let stops = 0;
    const cleanupError = Object.assign(new Error('cleanup deadline'), { code: 'cleanup_timeout' });
    const containment = {
      active: { generation: 1 },
      async stopGeneration() {
        stops += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        throw cleanupError;
      },
    };
    const coordinator = new ObserverCoordinator({
      configPath,
      installer: {
        async verify() { return { state: 'installed' }; },
        async removeInstalledArtifacts() { throw new Error('must not remove'); },
      },
      teardown: (options) => containment.stopGeneration(options),
    });
    const manager = new ObserverManager({
      coordinator, containment, authGate: { revalidateAuthContext: (value) => value },
    });
    manager.generation = 1;

    const started = Date.now();
    await assert.rejects(
      action === 'disable' ? manager.invalidateAndDisable() : manager.invalidateAndUninstall(),
      (error) => error?.cleanupAttempted === true,
    );
    assert.equal(stops, 1);
    assert.ok(Date.now() - started < 100, 'lifecycle reset the cleanup budget');
    assert.equal(manager._runtimeError, cleanupError);
    assert.equal(containment.active?.generation, 1);
  });
}

function deferredCleanup(f) {
  let finish;
  let stops = 0;
  f.containment.stopGeneration = () => {
    stops++;
    return new Promise((resolve, reject) => { finish = (error) => {
      if (error) reject(error);
      else { f.containment.active = null; resolve(); }
    }; });
  };
  return { finish: (error) => finish(error), stops: () => stops };
}

test('failure retirement fences immediately, coalesces, and supports repeated fresh demand', async () => {
  const f = fixture();
  for (let cycle = 0; cycle < 2; cycle++) {
    const oldLease = await f.manager.createLease(context('admin'));
    const old = f.containment.active;
    const cleanup = deferredCleanup(f);
    const retiring = f.manager.handleContainmentFailure(new Error('lost'), old);
    assert.equal(f.manager.runtimeStatus().state, 'retiring');
    assert.equal(f.manager.leases.size, 0);
    assert.equal(f.manager.handleContainmentFailure(new Error('duplicate'), old), retiring);
    const requests = [f.manager.createLease(context('admin')), f.manager.createLease(context('other'))];
    await new Promise(setImmediate);
    assert.equal(cleanup.stops(), 1);
    assert.equal(f.containment.active, old);
    cleanup.finish();
    const leases = await Promise.all(requests);
    await retiring;
    assert.notEqual(leases[0].id, leases[1].id);
    assert.notEqual(leases[0].id, oldLease.id);
    assert.notEqual(f.containment.active, old);
    assert.equal(f.manager.runtimeStatus().state, 'live');
    const live = f.containment.active;
    await f.manager.handleContainmentFailure(new Error('late'), old);
    assert.equal(f.containment.active, live);
    assert.equal(f.manager.leases.size, 2);
    f.manager.leases.clear();
  }
});

test('retirement cleanup uncertainty blocks admission and exposes its error', async () => {
  const f = fixture();
  await f.manager.createLease(context('admin'));
  const cleanup = deferredCleanup(f);
  const retiring = f.manager.handleContainmentFailure(new Error('lost'));
  const request = f.manager.createLease(context('admin'));
  await new Promise(setImmediate);
  cleanup.finish(Object.assign(new Error('survivors'), { code: 'cleanup_timeout' }));
  await retiring;
  await assert.rejects(request, { code: 'teardown_failed' });
  assert.deepEqual(f.manager.runtimeStatus(), { state: 'blocked', error: 'cleanup_timeout' });
  assert.equal(f.counts().starts, 1);
});

for (const action of ['disable', 'uninstall', 'shutdown', 'revoke']) {
  test(`retirement cannot admit a waiting viewer after ${action}`, async () => {
    const f = fixture();
    await f.manager.createLease(context('admin'));
    const originalStop = f.containment.stopGeneration;
    const cleanup = deferredCleanup(f);
    const retiring = f.manager.handleContainmentFailure(new Error('lost'));
    const request = f.manager.createLease(context('admin'));
    const rejected = assert.rejects(request, (error) => ['auth_required', 'operation_obsolete'].includes(error.code));
    await new Promise(setImmediate);
    let lifecycle;
    if (action === 'revoke') f.validCredentials.clear();
    else lifecycle = action === 'disable' ? f.manager.invalidateAndDisable() : action === 'uninstall' ? f.manager.invalidateAndUninstall() : f.manager.shutdown();
    f.containment.stopGeneration = originalStop;
    cleanup.finish();
    await Promise.all([retiring, rejected, lifecycle]);
    assert.equal(f.counts().starts, 1);
    assert.equal(f.manager.leases.size, 0);
    assert.equal(f.containment.active, null);
  });
}

test('create and renew return one-time WebSocket tickets bound to lease and principal', async () => {
  const f = fixture({ ticketTtlMs: 100 });
  const admin = context('admin');
  const lease = await f.manager.createLease(admin);
  const other = await f.manager.createLease(context('admin'));
  assert.match(lease.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(lease).sort(), ['expiresAt', 'generation', 'id', 'resource', 'ticket']);
  const renewed = f.manager.renewLease(lease.id, admin);
  assert.match(renewed.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(renewed.ticket, lease.ticket);

  assert.equal(f.manager.consumeTicket(lease.ticket, lease.id, context('admin', 'admin-refreshed')), true,
    'same stable principal may present the ticket');
  assert.equal(f.manager.consumeTicket(lease.ticket, lease.id, admin), false, 'tickets are single-use');
  assert.equal(f.manager.consumeTicket(other.ticket, lease.id, admin), false, 'ticket from another lease');
  assert.equal(f.manager.consumeTicket(renewed.ticket, lease.id, context('other')), false, 'ticket for another principal');
  assert.equal(f.manager.consumeTicket('x'.repeat(43), lease.id, admin), false, 'garbage ticket');
  assert.equal(f.manager.consumeTicket(undefined, lease.id, admin), false);

  const late = f.manager.renewLease(lease.id, admin).ticket;
  f.advance(100);
  assert.equal(f.manager.consumeTicket(late, lease.id, admin), false, 'expired ticket');
});

test('tickets are bounded per lease and dropped with their lease', async () => {
  const f = fixture();
  const admin = context('admin');
  const lease = await f.manager.createLease(admin);
  const tickets = [lease.ticket];
  for (let i = 0; i < 4; i += 1) tickets.push(f.manager.renewLease(lease.id, admin).ticket);
  assert.equal(f.manager.tickets.size, 3);
  assert.equal(f.manager.consumeTicket(tickets[0], lease.id, admin), false, 'oldest ticket was evicted');
  assert.equal(f.manager.consumeTicket(tickets[4], lease.id, admin), true);
  f.manager.releaseLease(lease.id, admin);
  assert.equal(f.manager.tickets.size, 0);
  assert.equal(f.manager.consumeTicket(tickets[3], lease.id, admin), false);

  const second = await f.manager.createLease(admin);
  await f.manager.invalidateAndDisable();
  assert.equal(f.manager.tickets.size, 0);
  assert.equal(f.manager.consumeTicket(second.ticket, second.id, admin), false);
});

test('Core Origin lease pins the current run and retires on replacement or unknown identity', async () => {
  let runId = 'origin-A';
  const f = fixture({ resolveOrigin: async () => { if (!runId) throw new Error('unknown identity'); return { runId, tmuxName: 'zylos-group-origin' }; } });
  f.coordinator.firstLease = async () => { f.containment.active={generation:5,originRunId:runId}; return f.containment.active; };
  try {
    const lease=await f.manager.createLease(context('admin'));
    assert.equal(lease.runId,'origin-A'); assert(f.manager.consumeTicket(lease.ticket,lease.id,context('admin')));
    runId='origin-B'; await f.manager.revalidate();
    assert.equal(f.manager.leases.size,0); assert.equal(f.containment.active,null);
    const next=await f.manager.createLease(context('admin'));
    assert.equal(next.runId,'origin-B');
    runId=null; await f.manager.revalidate();
    assert.equal(f.manager.leases.size,0); assert.equal(f.containment.active,null);
    await assert.rejects(f.manager.createLease(context('admin')),{code:'target_mismatch'});
  } finally { await f.manager.shutdown(); }
});

test('Core Origin lease creation rejects an unavailable current run', async () => {
  for (const resolveOrigin of [async () => ({ tmuxName: 'zylos-group-origin' }), async () => { throw new Error('not ready'); }]) {
    const f = fixture({ resolveOrigin });
    try {
      await assert.rejects(f.manager.createLease(context('admin')), { code: 'target_mismatch' });
      assert.equal(f.counts().starts, 0);
    } finally { await f.manager.shutdown(); }
  }
});

test('Origin replacement during attachment rejects the pending Observer lease', async () => {
  let runId = 'origin-A';
  let finishStart;
  const f = fixture({ resolveOrigin: async () => ({ runId, tmuxName: 'zylos-group-origin' }) });
  f.coordinator.firstLease = () => new Promise(resolve => {
    f.containment.active = { generation: 5, originRunId: 'origin-A' };
    finishStart = () => resolve(f.containment.active);
  });
  try {
    const pending = f.manager.createLease(context('admin'));
    await new Promise(resolve => setImmediate(resolve));
    runId = 'origin-B';
    finishStart();
    await assert.rejects(pending, { code: 'target_mismatch' });
    assert.equal(f.manager.leases.size, 0);
  } finally { await f.manager.shutdown(); }
});
