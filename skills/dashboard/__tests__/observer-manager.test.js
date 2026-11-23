import assert from 'node:assert/strict';
import test from 'node:test';

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
