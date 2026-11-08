import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTimezoneSettings, validTimezone } from '../public/js/wb/settings-timezone.js';
import { documentFixture } from './fixtures/settings-dom.js';
import { deferred } from './fixtures/workbench-dom.js';

const settings = (extra = {}) => ({ tz: 'UTC', writable: true, read_only_reason: null,
  restart_status: 'known', restart_services: [{ name: 'scheduler', status: 'online' }], ...extra });
function fixture(options = {}) {
  const document = documentFixture(), root = document.createElement('div'), writes = [], restarts = [], questions = [];
  const view = mountTimezoneSettings(root, { document,
    read: async () => settings(), write: async body => { writes.push(body); return settings({ tz: body.tz, ok: true, changed: true }); },
    restart: async body => { restarts.push(body); return { ok: true, restarted: ['scheduler'], failed: [], restart_services: [] }; },
    confirm: async text => { questions.push(text); return true; }, ...options });
  return { root, view, writes, restarts, questions, input: root.querySelector('input'),
    save: root.querySelector('#settings-timezone-save'), restart: root.querySelector('#settings-timezone-restart'),
    pending: root.querySelector('#settings-timezone-pending'), notice: root.querySelector('#settings-timezone-result'),
    policy: root.querySelector('#settings-timezone-policy') };
}
async function save(f, tz = 'Asia/Singapore') { f.input.value = tz; await f.input.dispatch('input'); await f.save.dispatch('click'); }

test('time zone validation rejects unknown or empty values and permits valid IANA zones', () => {
  for (const value of ['', null, 'Not/AZone', 4]) assert.equal(validTimezone(value), false);
  for (const value of ['UTC', ' Asia/Singapore ', 'America/New_York']) assert.equal(validTimezone(value), true);
});
test('saving writes the zone and requires a separate confirmation to restart', async () => {
  const f = fixture(); await f.view.refresh(); await save(f);
  assert.deepEqual(f.writes, [{ tz: 'Asia/Singapore' }]); assert.equal(f.restarts.length, 0);
  assert.equal(f.pending.hidden, false); assert.equal(f.root.querySelector('#settings-timezone-services').textContent, 'wb.settings.timezone.scheduler');
  await f.restart.dispatch('click'); assert.deepEqual(f.restarts, [{ tz: 'Asia/Singapore', confirm: true, services: ['scheduler'] }]);
  assert.equal(f.questions.length, 2); assert.equal(f.pending.hidden, true);
});
test('cancelled save or restart leaves the corresponding operation untouched', async () => {
  let accepted = false; const f = fixture({ confirm: async () => accepted }); await f.view.refresh(); await save(f);
  assert.equal(f.writes.length, 0); accepted = true; await save(f); accepted = false; await f.restart.dispatch('click');
  assert.equal(f.writes.length, 1); assert.equal(f.restarts.length, 0); assert.equal(f.pending.hidden, false);
});
test('invalid input cannot write and an unknown but readable current zone can be repaired', async () => {
  const f = fixture({ read: async () => settings({ tz: null }) }); await f.view.refresh();
  assert.equal(f.input.disabled, false); await save(f, 'not/a-zone'); assert.equal(f.save.disabled, true); assert.equal(f.writes.length, 0);
  await save(f); assert.equal(f.writes.length, 1);
});
test('read-only remote and managed deployments reject dispatched writes and restarts', async () => {
  for (const options of [{ writable: () => false }, { read: async () => settings({ writable: false, read_only_reason: 'timezone_managed' }) }]) {
    const f = fixture(options); await f.view.refresh(); await save(f); await f.restart.dispatch('click');
    assert.equal(f.input.disabled, true); assert.equal(f.writes.length, 0); assert.equal(f.restarts.length, 0);
    assert.match(f.policy.textContent, /readOnlyRemote|managed/);
  }
});
test('temporary action unavailability disables controls without claiming remote access is read-only', async () => {
  const f = fixture({ available: () => false }); await f.view.refresh(); await save(f);
  assert.equal(f.save.disabled, true); assert.equal(f.policy.textContent, ''); assert.equal(f.writes.length, 0);
});
test('saving an unchanged zone still offers the advisory service confirmation', async () => {
  const f = fixture({ write: async () => settings({ ok: true, changed: false }) }); await f.view.refresh(); await save(f, 'UTC');
  assert.equal(f.pending.hidden, false); assert.equal(f.restart.disabled, false);
});
test('unknown discovery disables restart and a fresh read can recover the advisory list', async () => {
  const f = fixture({ write: async () => settings({ restart_status: 'unknown', restart_services: [] }) }); await f.view.refresh(); await save(f, 'UTC');
  assert.equal(f.restart.disabled, true); await f.restart.dispatch('click'); assert.equal(f.restarts.length, 0);
  await f.root.querySelector('#settings-timezone-retry').dispatch('click'); assert.equal(f.restart.disabled, false);
});
test('partial failures preserve failed services for an explicit retry', async () => {
  const f = fixture({ restart: async () => ({ ok: false, restarted: [], failed: [{ name: 'scheduler', error: 'restart_failed' }], restart_services: [{ name: 'scheduler', status: 'online' }] }) });
  await f.view.refresh(); await save(f); await f.restart.dispatch('click');
  assert.equal(f.pending.hidden, false); assert.equal(f.restart.disabled, false); assert.equal(f.notice.textContent, 'wb.settings.timezone.restartFailed');
});
test('identity changes block stale controls immediately and ignore a delayed read', async () => {
  let identity = 'first'; const f = fixture({ identity: () => identity }); await f.view.refresh(); identity = 'second';
  await save(f); assert.equal(f.writes.length, 0);
  const pending = deferred(), g = fixture({ identity: () => identity, read: () => pending.promise }); const reading = g.view.refresh();
  identity = 'third'; pending.resolve(settings()); await reading; assert.equal(g.input.value, ''); assert.equal(g.input.disabled, true);
});
test('leaving settings or changing target cancels a pending confirmation before writing', async () => {
  for (const change of ['invalidate', 'identity']) {
    let identity = 'first'; const confirmation = deferred(), f = fixture({ identity: () => identity, confirm: () => confirmation.promise });
    await f.view.refresh(); const saving = save(f); if (change === 'invalidate') f.view.invalidate(); else identity = 'second';
    confirmation.resolve(true); await saving; assert.equal(f.writes.length, 0); assert.equal(f.restarts.length, 0);
  }
});
test('invalidation ignores a delayed save result and duplicate clicks cannot issue a second write', async () => {
  const pending = deferred(), writes = [], f = fixture({ write: body => { writes.push(body); return pending.promise; } }); await f.view.refresh();
  const saving = save(f); await new Promise(resolve => setImmediate(resolve)); await f.save.dispatch('click'); assert.equal(writes.length, 1);
  f.view.invalidate(); pending.resolve(settings({ tz: 'Asia/Singapore' })); await saving;
  assert.equal(f.input.value, ''); assert.equal(f.pending.hidden, true); assert.equal(f.notice.textContent, '');
});
test('editing the saved value prevents restarting a different zone', async () => {
  const f = fixture(); await f.view.refresh(); await save(f); f.input.value = 'America/New_York'; await f.input.dispatch('input');
  await f.restart.dispatch('click'); assert.equal(f.restarts.length, 0); assert.equal(f.restart.disabled, true);
});

test('an outstanding restart confirmation is discarded after leaving or switching instance', async () => {
  for (const change of ['invalidate', 'identity']) {
    let identity = 'first', asks = 0; const confirmation = deferred();
    const f = fixture({ identity: () => identity, confirm: () => ++asks === 1 ? true : confirmation.promise });
    await f.view.refresh(); await save(f); const restarting = f.restart.dispatch('click');
    if (change === 'invalidate') f.view.invalidate(); else identity = 'second';
    confirmation.resolve(true); await restarting; assert.equal(f.restarts.length, 0);
  }
});
test('restart sends exactly the services shown before confirmation without adding new candidates', async () => {
  const pending = deferred(), value = settings({ tz: 'Asia/Singapore' }); let asks = 0;
  const f = fixture({ write: async () => value, confirm: () => ++asks === 1 ? true : pending.promise });
  await f.view.refresh(); await save(f); const restarting = f.restart.dispatch('click');
  value.restart_services.push({ name: 'web-console', status: 'online' });
  pending.resolve(true); await restarting;
  assert.deepEqual(f.restarts, [{ tz: 'Asia/Singapore', confirm: true, services: ['scheduler'] }]);
});
test('a partial restart retries only failed services from its new confirmation list', async () => {
  const calls = [], f = fixture({
    write: async body => settings({ tz: body.tz, restart_services: [{ name: 'scheduler' }, { name: 'web-console' }] }),
    restart: async body => { calls.push(body); return calls.length === 1
      ? { ok: false, restarted: ['web-console'], failed: [{ name: 'scheduler', error: 'restart_failed' }], restart_services: [{ name: 'scheduler' }] }
      : { ok: true, restarted: ['scheduler'], failed: [], restart_services: [] }; },
  });
  await f.view.refresh(); await save(f); await f.restart.dispatch('click'); await f.restart.dispatch('click');
  assert.deepEqual(calls.map(call => call.services), [['scheduler', 'web-console'], ['scheduler']]);
  assert.equal(f.pending.hidden, true);
});
test('a rejected restart explains its cause instead of naming an empty failed-service list', async () => {
  for (const [error, key] of [['duplicate_request', 'duplicate'], ['confirmation_required', 'confirmationRequired'], ['service_discovery_unavailable', 'discoveryUnknown']]) {
    const f = fixture({ restart: async () => ({ ok: false, error, failed: [], restart_services: [{ name: 'scheduler' }] }) });
    await f.view.refresh(); await save(f); await f.restart.dispatch('click');
    assert.equal(f.notice.textContent, 'wb.settings.timezone.' + key); assert.equal(f.pending.hidden, false);
  }
});

test('rediscovery after partial progress cannot add a successfully restarted service back to retry', async () => {
  const calls = [], f = fixture({
    read: async () => settings({ restart_services: [{ name: 'scheduler' }, { name: 'web-console' }] }),
    write: async body => settings({ tz: body.tz, restart_services: [{ name: 'scheduler' }, { name: 'web-console' }] }),
    restart: async body => { calls.push(body); return calls.length === 1
      ? { ok: false, error: 'service_discovery_unavailable', restarted: ['scheduler'], failed: [], restart_status: 'unknown', restart_services: [{ name: 'web-console' }] }
      : { ok: true, restarted: ['web-console'], failed: [], restart_services: [] }; },
  });
  await f.view.refresh(); await save(f, 'UTC'); await f.restart.dispatch('click');
  assert.equal(f.restart.disabled, true);
  await f.root.querySelector('#settings-timezone-retry').dispatch('click');
  assert.equal(f.restart.disabled, false); await f.restart.dispatch('click');
  assert.deepEqual(calls.map(call => call.services), [['scheduler', 'web-console'], ['web-console']]);
});

test('an HTTP error preserves successful restart progress through rediscovery and retry', async () => {
  const calls = [], f = fixture({
    read: async () => settings({ restart_services: [{ name: 'scheduler' }, { name: 'web-console' }] }),
    write: async body => settings({ tz: body.tz, restart_services: [{ name: 'scheduler' }, { name: 'web-console' }] }),
    restart: async body => {
      calls.push(body);
      if (calls.length === 1) {
        const error = new Error('service_discovery_unavailable'); error.code = error.message;
        error.result = { ok: false, restarted: ['scheduler'], failed: [], restart_status: 'unknown', restart_services: [{ name: 'web-console' }] };
        throw error;
      }
      return { ok: true, restarted: ['web-console'], failed: [], restart_services: [] };
    },
  });
  await f.view.refresh(); await save(f, 'UTC'); await f.restart.dispatch('click');
  assert.equal(f.restart.disabled, true); assert.equal(f.notice.textContent, 'wb.settings.timezone.discoveryUnknown');
  assert.equal(f.root.querySelector('#settings-timezone-services').textContent, 'wb.settings.timezone.webConsole');
  await f.root.querySelector('#settings-timezone-retry').dispatch('click'); await f.restart.dispatch('click');
  assert.deepEqual(calls.map(call => call.services), [['scheduler', 'web-console'], ['web-console']]);
});

test('initial discovery failure retains the confirmed services for an explicit retry after recovery', async () => {
  const calls = [], f = fixture({
    read: async () => settings({ restart_services: [{ name: 'scheduler' }, { name: 'web-console' }] }),
    write: async body => settings({ tz: body.tz, restart_services: [{ name: 'scheduler' }] }),
    restart: async body => {
      calls.push(body);
      if (calls.length === 1) {
        const error = new Error('service_discovery_unavailable'); error.code = error.message;
        error.result = { ok: false, restarted: [], failed: [], restart_status: 'unknown', restart_services: [{ name: 'scheduler' }] };
        throw error;
      }
      return { ok: true, restarted: ['scheduler'], failed: [], restart_services: [] };
    },
  });
  await f.view.refresh(); await save(f, 'UTC'); await f.restart.dispatch('click');
  assert.equal(f.pending.hidden, false); assert.equal(f.restart.disabled, true);
  assert.equal(f.root.querySelector('#settings-timezone-services').textContent, 'wb.settings.timezone.scheduler');
  await f.root.querySelector('#settings-timezone-retry').dispatch('click');
  assert.equal(f.restart.disabled, false);
  assert.equal(f.root.querySelector('#settings-timezone-services').textContent, 'wb.settings.timezone.scheduler');
  await f.restart.dispatch('click');
  assert.deepEqual(calls.map(call => call.services), [['scheduler'], ['scheduler']]);
  assert.equal(f.pending.hidden, true);
});
