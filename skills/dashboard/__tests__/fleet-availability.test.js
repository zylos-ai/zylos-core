import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetPoller, stateToFleetRecord } from '../src/lib/fleet-poller.js';
import { buildAgentFleetView, fleetSelfFromSnapshot, renderAgentFleetHtml } from '../public/js/agent-fleet.js';

// Real conversion and rendering modules, in-memory inputs only; no HTTP,
// process, configuration or database resource is opened.
for (const mode of ['single', 'multi']) {
  test(`reachable unknown self retains ${mode} mode and never counts as offline`, () => {
    const local = stateToFleetRecord({ name: 'local' }, { state: 'UNKNOWN' }, { self: true, nowMs: 0 });
    const remote = stateToFleetRecord({ name: 'remote' }, { state: 'UNKNOWN' }, { nowMs: 0 });
    const self = fleetSelfFromSnapshot({ mode, counts: { idle: 1 }, rows: [{}] });
    const fleet = { agents: [local, remote] };
    const view = buildAgentFleetView(fleet, { self });
    assert.equal(view.counts.offline, 0);
    assert.equal(view.tiles[0].offline, false);
    assert.equal(view.tiles[0].mood, 'unknown');
    assert.equal(view.tiles[0].stateLabel, view.tiles[1].stateLabel);
    assert.equal(view.tiles[0].stateLabel, 'Unknown');
    const html = renderAgentFleetHtml(fleet, { self });
    assert.doesNotMatch(html, /wb-f-card bad|Cannot connect|agent-fleet-reason|Mode unknown/);
    assert.match(html, /0 Offline/);
    assert.match(html, /data-mood="unknown"/);
    assert.match(html, new RegExp(mode === 'multi' ? 'Multi-session' : 'Single session'));
  });
}

test('healthy self keeps its normal state and mode labels', () => {
  for (const state of ['IDLE', 'BUSY']) {
    const record = stateToFleetRecord({ name: 'local' }, { state, running_tools: state === 'BUSY' ? [{ tool_name: 'Bash', tool_detail: 'work' }] : [] }, { self: true, nowMs: 0 });
    const view = buildAgentFleetView({ agents: [record] }, { self: fleetSelfFromSnapshot({ mode: 'single' }) });
    assert.equal(view.tiles[0].offline, false);
    assert.equal(view.tiles[0].mood, state.toLowerCase());
    assert.equal(view.tiles[0].stateLabel, state === 'IDLE' ? 'Idle' : 'Working');
    assert.equal(view.counts.offline, 0);
    assert.match(renderAgentFleetHtml({ agents: [record] }, { self: { mode: 'single' } }), /Single session/);
  }
});

test('remote connection failure remains offline beside an unknown reachable self', async () => {
  const poller = new FleetPoller({ fleet: { agents: [{ name: 'remote', base_url: 'https://unreachable.example.test', read_api_key: 'test-key' }] } }, {
    fetch: async () => { throw new Error('connection failed'); }, now: () => 0,
  });
  await poller.pollOnce();
  const local = stateToFleetRecord({ name: 'local' }, { state: 'UNKNOWN' }, { self: true, nowMs: 0 });
  const fleet = { agents: [local, ...poller.getFleet().agents] };
  const view = buildAgentFleetView(fleet, { self: { mode: 'multi' } });
  assert.equal(view.counts.offline, 1);
  assert.equal(view.tiles.find(tile => tile.isSelf).offline, false);
  assert.equal(view.tiles.find(tile => !tile.isSelf).offline, true);
  const html = renderAgentFleetHtml(fleet, { self: { mode: 'multi' } });
  assert.match(html, /wb-f-card bad" data-agent="remote"/);
  assert.match(html, /1 Offline/);
  assert.match(html, /Cannot connect/);
});

test('the local mode label comes from the configuration snapshot even with an offline observation', () => {
  const fleet = { agents: [{ name: 'local', self: true, state: 'OFFLINE', pulse_rate: 0, health_reason: 'offline' }] };
  for (const mode of ['single', 'multi']) {
    const html = renderAgentFleetHtml(fleet, { self: fleetSelfFromSnapshot({ mode }) });
    assert.match(html, new RegExp(mode === 'multi' ? 'Multi-session' : 'Single session'));
    assert.doesNotMatch(html, /Mode unknown/);
  }
});

test('explicit offline runtime states retain the shared self and remote judgment', () => {
  const local = stateToFleetRecord({ name: 'local' }, { state: 'OFFLINE' }, { self: true });
  const remote = stateToFleetRecord({ name: 'remote' }, { state: 'OFFLINE' });
  const view = buildAgentFleetView({ agents: [local, remote] });
  assert.equal(view.tiles[0].offline, view.tiles[1].offline);
  assert.equal(view.tiles[0].mood, view.tiles[1].mood);
});

test('an explicit remote stuck reason still takes precedence over unknown runtime state', () => {
  const view = buildAgentFleetView({ agents: [{ name: 'remote', state: 'UNKNOWN', health_reason: 'stuck', pulse_rate: 1 }] });
  assert.equal(view.tiles[0].mood, 'stuck');
  assert.equal(view.tiles[0].offline, false);
});
