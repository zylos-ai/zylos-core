import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTimezoneSettings, validTimezone } from '../public/js/wb/settings-timezone.js';
import { canonicalTimezoneName, timezoneOptions } from '../public/js/wb/timezone-names.js';
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
  return { root, view, writes, restarts, questions, input: root.querySelector('select'),
    save: root.querySelector('#settings-timezone-save'), restart: root.querySelector('#settings-timezone-restart'),
    pending: root.querySelector('#settings-timezone-pending'), notice: root.querySelector('#settings-timezone-result'),
    policy: root.querySelector('#settings-timezone-policy') };
}
async function save(f, tz = 'Asia/Singapore') { f.input.value = tz; await f.input.dispatch('change'); await f.save.dispatch('click'); }

test('time zone validation rejects unknown or empty values and permits valid IANA zones', () => {
  for (const value of ['', null, 'Not/AZone', 4]) assert.equal(validTimezone(value), false);
  for (const value of ['UTC', ' Asia/Singapore ', 'America/New_York']) assert.equal(validTimezone(value), true);
});
test('time zone card uses the shared decorative clock icon', async () => {
  const f = fixture(); await f.view.refresh();
  const heading = f.root.querySelector('h4');
  assert.equal(heading.children[0].classList.contains('wb-ico-clock'), true);
  assert.equal(heading.children[0].getAttribute('aria-hidden'), 'true');
  assert.equal(heading.children[1].textContent, 'wb.settings.timezone.title');
});
test('host timezone rejection displays its specific reason and keeps the saved value untouched', async () => {
  const f = fixture({ write: async () => { const error = new Error('timezone_unavailable_on_host'); error.code = error.message; throw error; } });
  await f.view.refresh(); await save(f, 'Asia/Kolkata');
  assert.equal(f.notice.textContent, 'wb.settings.timezone.hostUnsupported');
  assert.equal(f.pending.hidden, true); assert.equal(f.restarts.length, 0);
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
test('read-only remote and unreadable configuration reject dispatched writes and restarts', async () => {
  for (const options of [{ writable: () => false }, { read: async () => settings({ writable: false, read_only_reason: 'tz_env_read_error' }) }]) {
    const f = fixture(options); await f.view.refresh(); await save(f); await f.restart.dispatch('click');
    assert.equal(f.input.disabled, true); assert.equal(f.writes.length, 0); assert.equal(f.restarts.length, 0);
    assert.match(f.policy.textContent, /readOnlyRemote|readOnly/);
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
  const f = fixture(); await f.view.refresh(); await save(f); f.input.value = 'America/New_York'; await f.input.dispatch('change');
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
  value.restart_services.push({ name: 'activity-monitor', status: 'online' });
  pending.resolve(true); await restarting;
  assert.deepEqual(f.restarts, [{ tz: 'Asia/Singapore', confirm: true, services: ['scheduler'] }]);
});
test('a partial restart retries only failed services from its new confirmation list', async () => {
  const calls = [], f = fixture({
    write: async body => settings({ tz: body.tz, restart_services: [{ name: 'scheduler' }, { name: 'activity-monitor' }] }),
    restart: async body => { calls.push(body); return calls.length === 1
      ? { ok: false, restarted: ['activity-monitor'], failed: [{ name: 'scheduler', error: 'restart_failed' }], restart_services: [{ name: 'scheduler' }] }
      : { ok: true, restarted: ['scheduler'], failed: [], restart_services: [] }; },
  });
  await f.view.refresh(); await save(f); await f.restart.dispatch('click'); await f.restart.dispatch('click');
  assert.deepEqual(calls.map(call => call.services), [['scheduler', 'activity-monitor'], ['scheduler']]);
  assert.equal(f.pending.hidden, true);
});
test('a rejected restart explains its cause instead of naming an empty failed-service list', async () => {
  for (const [error, key] of [['confirmation_required', 'confirmationRequired'], ['service_discovery_unavailable', 'discoveryUnknown']]) {
    const f = fixture({ restart: async () => ({ ok: false, error, failed: [], restart_services: [{ name: 'scheduler' }] }) });
    await f.view.refresh(); await save(f); await f.restart.dispatch('click');
    assert.equal(f.notice.textContent, 'wb.settings.timezone.' + key); assert.equal(f.pending.hidden, false);
  }
});

test('rediscovery after partial progress cannot add a successfully restarted service back to retry', async () => {
  const calls = [], f = fixture({
    read: async () => settings({ restart_services: [{ name: 'scheduler' }, { name: 'activity-monitor' }] }),
    write: async body => settings({ tz: body.tz, restart_services: [{ name: 'scheduler' }, { name: 'activity-monitor' }] }),
    restart: async body => { calls.push(body); return calls.length === 1
      ? { ok: false, error: 'service_discovery_unavailable', restarted: ['scheduler'], failed: [], restart_status: 'unknown', restart_services: [{ name: 'activity-monitor' }] }
      : { ok: true, restarted: ['activity-monitor'], failed: [], restart_services: [] }; },
  });
  await f.view.refresh(); await save(f, 'UTC'); await f.restart.dispatch('click');
  assert.equal(f.restart.disabled, true);
  await f.root.querySelector('#settings-timezone-retry').dispatch('click');
  assert.equal(f.restart.disabled, false); await f.restart.dispatch('click');
  assert.deepEqual(calls.map(call => call.services), [['scheduler', 'activity-monitor'], ['activity-monitor']]);
});

test('an HTTP error preserves successful restart progress through rediscovery and retry', async () => {
  const calls = [], f = fixture({
    read: async () => settings({ restart_services: [{ name: 'scheduler' }, { name: 'activity-monitor' }] }),
    write: async body => settings({ tz: body.tz, restart_services: [{ name: 'scheduler' }, { name: 'activity-monitor' }] }),
    restart: async body => {
      calls.push(body);
      if (calls.length === 1) {
        const error = new Error('service_discovery_unavailable'); error.code = error.message;
        error.result = { ok: false, restarted: ['scheduler'], failed: [], restart_status: 'unknown', restart_services: [{ name: 'activity-monitor' }] };
        throw error;
      }
      return { ok: true, restarted: ['activity-monitor'], failed: [], restart_services: [] };
    },
  });
  await f.view.refresh(); await save(f, 'UTC'); await f.restart.dispatch('click');
  assert.equal(f.restart.disabled, true); assert.equal(f.notice.textContent, 'wb.settings.timezone.discoveryUnknown');
  assert.equal(f.root.querySelector('#settings-timezone-services').textContent, 'wb.settings.timezone.activityMonitor');
  await f.root.querySelector('#settings-timezone-retry').dispatch('click'); await f.restart.dispatch('click');
  assert.deepEqual(calls.map(call => call.services), [['scheduler', 'activity-monitor'], ['activity-monitor']]);
});

test('initial discovery failure retains the confirmed services for an explicit retry after recovery', async () => {
  const calls = [], f = fixture({
    read: async () => settings({ restart_services: [{ name: 'scheduler' }, { name: 'activity-monitor' }] }),
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

// Expected country-location names follow IANA 2026e backward/backzone, independently
// of ICU's old primary identifiers. Every renamed option must disappear from the DOM.
const renamedZones = [
  ['Africa/Asmera', 'Africa/Asmara'],
  ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ['America/Catamarca', 'America/Argentina/Catamarca'],
  ['America/Coral_Harbour', 'America/Atikokan'],
  ['America/Cordoba', 'America/Argentina/Cordoba'],
  ['America/Godthab', 'America/Nuuk'],
  ['America/Indianapolis', 'America/Indiana/Indianapolis'],
  ['America/Jujuy', 'America/Argentina/Jujuy'],
  ['America/Louisville', 'America/Kentucky/Louisville'],
  ['America/Mendoza', 'America/Argentina/Mendoza'],
  ['Asia/Calcutta', 'Asia/Kolkata'], ['Asia/Katmandu', 'Asia/Kathmandu'],
  ['Asia/Rangoon', 'Asia/Yangon'], ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
  ['Atlantic/Faeroe', 'Atlantic/Faroe'], ['Europe/Kiev', 'Europe/Kyiv'],
  ['Pacific/Enderbury', 'Pacific/Kanton'], ['Pacific/Ponape', 'Pacific/Pohnpei'],
  ['Pacific/Truk', 'Pacific/Chuuk'],
];
test('time zone options map old identifiers to current IANA country locations without duplicates', async () => {
  const supplied = renamedZones.flat(), options = timezoneOptions(supplied);
  assert.equal(options.length, renamedZones.length + 1);
  for (const [old, current] of renamedZones) {
    assert.equal(canonicalTimezoneName(old), current);
    assert.equal(canonicalTimezoneName(current), current);
    assert.equal(options.includes(old), false, old);
    assert.equal(options.includes(current), true, current);
    assert.equal(validTimezone(old), false, old);
  }
  assert.equal(canonicalTimezoneName('asia/calcutta'), 'asia/calcutta', 'Mapping never repairs spelling');
  const f = fixture(); await f.view.refresh();
  const actual = f.input.querySelectorAll('option').map(option => option.value);
  assert.equal(new Set(actual).size, actual.length);
  const suppliedByIntl = Intl.supportedValuesOf('timeZone');
  for (const [old, current] of renamedZones) {
    assert.equal(actual.includes(old), false, old);
    if (suppliedByIntl.includes(old) || suppliedByIntl.includes(current)) assert.equal(actual.includes(current), true, current);
  }
  assert.ok(f.input.querySelectorAll('optgroup').length > 1, 'Regions make the native dropdown navigable');
  for (const name of ['Africa/Accra', 'Asia/Kuala_Lumpur']) assert.equal(actual.includes(name), suppliedByIntl.includes(name), 'Keep current geographic names');
});
test('an unlisted current value remains visible unchanged until an explicit choice is saved', async () => {
  for (const tz of ['Asia/Calcutta', 'Custom/Legacy']) {
    const f = fixture({ read: async () => settings({ tz }) }); await f.view.refresh();
    assert.equal(f.input.value, tz);
    const original = f.input.querySelectorAll('option').find(option => option.value === tz);
    assert.equal(original.textContent, tz); assert.equal(original.disabled, true);
    assert.equal(f.save.disabled, true); await f.save.dispatch('click'); assert.equal(f.writes.length, 0);
    await save(f, 'Asia/Kolkata'); assert.equal(f.writes[0].tz, 'Asia/Kolkata');
  }
});
test('restart service labels cover the core monitor and dispatcher', async () => {
  const f = fixture({ write: async body => settings({ tz: body.tz, restart_services: [{ name: 'activity-monitor' }, { name: 'c4-dispatcher' }] }) });
  await f.view.refresh(); await save(f);
  assert.equal(f.root.querySelector('#settings-timezone-services').textContent,
    'wb.settings.timezone.activityMonitorwb.settings.timezone.dispatcher');
});
