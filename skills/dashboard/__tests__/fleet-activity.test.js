import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildAgentFleetView, defaultAgentFleetLabels, renderAgentFleetHtml } from '../public/js/agent-fleet.js';
import { fleetStateFromObjects, stateToFleetRecord } from '../src/lib/fleet-poller.js';
import { fleetGroupSummary } from '../src/lib/workbench/fleet-summary.js';

const states = [
  ['BUSY', 'busy', 'Working', 'busy'], ['IDLE', 'idle', 'Idle', 'idle'],
  ['UNKNOWN', 'unknown', 'Unknown', 'unknown'], ['AUTH_WAIT', 'stuck', 'Waiting for authentication', 'waiting'],
];
for (const mode of ['single', 'multi']) for (const [state, mood, label, kind] of states) {
  test(`${mode} ${state} cards retain actual status without an action row`, () => {
    const summary = fleetGroupSummary({ mode: 'multi', listKnown: true,
      rows: [{ sessionGroup: 'origin', presence: 'running', state: { kind } }], instance: {} });
    const agent = stateToFleetRecord({ name: mode }, { state, session_mode: mode, group_summary: summary });
    for (const key of ['activity', 'activity_feed']) assert.equal(Object.hasOwn(agent, key), false);
    const view = buildAgentFleetView({ agents: [agent] });
    for (const key of ['activity', 'activityFeed']) assert.equal(Object.hasOwn(view.tiles[0], key), false);
    assert.equal(view.tiles[0].mood, mood);
    assert.equal(view.tiles[0].stateLabel, label);
    const html = renderAgentFleetHtml({ agents: [agent] });
    assert.doesNotMatch(html, /Standing by|<span title="/);
    if (mode === 'single') {
      assert.ok(html.includes(`data-mood="${mood}"`));
      assert.ok(html.includes(`>${label}</span>`));
      const row = html.match(/<div class="wb-f-act">(.*?)<\/div>/s)?.[1];
      assert.ok(row);
      assert.equal((row.match(/<span/g) || []).length, 2, 'only the status pill and its dot');
    } else {
      assert.match(html, /Running 1 group/);
      assert.ok(html.includes(`1 ${kind === 'busy' ? 'working' : kind}`));
    }
  });
}

test('object-backed working and idle instances have state-only cards', () => {
  for (const [state, kind] of [['BUSY', 'working'], ['IDLE', 'idle']]) {
    const payload = fleetStateFromObjects({ session_mode: { sessionMode: 'single' } }, {
      listKnown: true, running: { total: 1, states: { working: 0, idle: 0, starting: 0, stopping: 0, unknown: 0, [kind]: 1 } },
    }, { today: { cost: null }, sevenDay: { cost: null } }, { rows: [{ id: 'origin', state: { kind } }] });
    const agent = stateToFleetRecord({ name: 'single' }, payload);
    assert.equal(agent.state, state);
    assert.doesNotMatch(renderAgentFleetHtml({ agents: [agent] }), /Standing by|<span title="/);
  }
});

test('fleet label packs omit the removed standby wording', () => {
  assert.equal(Object.hasOwn(defaultAgentFleetLabels(), 'noActivity'), false);
  for (const locale of ['en', 'zh']) {
    const labels = JSON.parse(fs.readFileSync(new URL(`../public/i18n/${locale}.json`, import.meta.url), 'utf8'));
    assert.equal(Object.hasOwn(labels, 'agent_fleet.no_activity'), false);
  }
});
