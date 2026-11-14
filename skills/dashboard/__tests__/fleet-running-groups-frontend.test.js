import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentFleetView, fleetSelfFromSnapshot, handleFleetClick, renderAgentFleetHtml } from '../public/js/agent-fleet.js';

// Exercise the real renderer with API-shaped inputs; no server or live state.
function summary(extra = {}) {
  return { running: 4, listKnown: true,
    counts: { busy: 1, idle: 2, waiting: 1, unknown: 0, error: 0, no_response: null },
    problemCount: 0, problems: [], pool: { used: 3, capacity: 12 }, noResponse: null, autoRestarts: null, ...extra };
}
function machine(extra = {}) {
  return { name: 'fixture', state: 'IDLE', session_mode: 'multi', group_summary: summary(), ...extra };
}
function render(agent, options) { return renderAgentFleetHtml({ agents: [agent] }, options); }
function groupSection(html) {
  return html.slice(html.indexOf('<div class="wb-f-act'), html.indexOf('<div class="wb-qbars'));
}

test('running totals come from Fleet API summary, never snapshot row count or pool occupancy', () => {
  const self = fleetSelfFromSnapshot({ mode: 'multi', counts: { busy: 99, error: 55 },
    rows: Array(19).fill({}), instance: { pool: { used: 18, capacity: 90 } } });
  const html = render(machine({ self: true }), { self });
  assert.match(html, /Running 4 groups · 1 working · 2 idle · 1 waiting/);
  assert.match(html, /Pool<b>3\/12<\/b>/);
  assert.doesNotMatch(html, /19 groups|99 working|55 error|running 18|\/90/);
  assert.match(html, /All normal/);
});

test('pool occupancy is shown for local and remote cards, with unknown capacity omitted', () => {
  for (const self of [false, true]) for (const pool of [{ used: 9, capacity: 12 }, { used: 9, capacity: null }, null]) {
    const html = render(machine({ self, group_summary: summary({ pool }) }), { self: { mode: 'multi' } });
    const value = pool?.capacity ? '9/12' : pool ? '9' : '--';
    assert.ok(html.includes(`Pool<b>${value}</b>`));
    assert.doesNotMatch(html, /Groups<b>/);
  }
});

test('local and remote multi-session machines render the same running group section', () => {
  const local = render(machine({ self: true }), { self: { mode: 'multi' } });
  const remote = render(machine());
  assert.equal(groupSection(local), groupSection(remote));
});

test('remote mode is explicit and legacy payloads retain unknown mode', () => {
  for (const mode of ['single', 'multi']) {
    const agent = machine({ session_mode: mode });
    assert.equal(buildAgentFleetView({ agents: [agent] }).tiles[0].sessionMode, mode);
    assert.match(render(agent), new RegExp(mode === 'multi' ? 'Multi-session' : 'Single session'));
  }
  for (const session_mode of [undefined, null, 'unknown']) {
    const html = render(machine({ session_mode }));
    assert.match(html, /Mode unknown/);
    assert.doesNotMatch(html, /Multi-session|Single session|Running 4 groups/);
  }
});

test('absent summary or unknown list never declares all groups normal', () => {
  for (const group_summary of [null, summary({ listKnown: false })]) {
    const html = render(machine({ group_summary }), { self: { mode: 'multi', counts: { idle: 42 } } });
    assert.match(html, /Group statistics unavailable/);
    assert.doesNotMatch(html, /All normal|Running 4 groups|wb-gbar/);
  }
});

test('known list with unknown group states keeps its counts without declaring all normal', () => {
  const html = render(machine({ group_summary: summary({ counts: { busy: 1, idle: 1, waiting: 1, unknown: 1 } }) }));
  assert.match(html, /Running 4 groups · 1 working · 1 idle · 1 waiting · 1 unknown/);
  assert.match(html, /wb-gbar-unknown/);
  assert.match(html, /Group statistics unavailable/);
  assert.doesNotMatch(html, /All normal|class="wb-f-problem"/);
});

test('problem list shows two saved names, escapes content, and preserves the full problem count', () => {
  const group_summary = summary({ problemCount: 5, counts: { error: 4 }, problems: [
    { sessionGroup: 'private"<&', displayName: 'Saved "<ops>&', reason: 'auth_failed', durationSeconds: null },
    { sessionGroup: 'second', name: { displayName: 'Saved conversation' }, reason: 'start_failed' },
    { sessionGroup: 'third', displayName: 'Must not appear', reason: 'auth_failed' },
  ] });
  const html = render(machine({ group_summary }));
  assert.equal((html.match(/class="wb-f-problem"/g) || []).length, 2);
  assert.match(html, /Saved &quot;&lt;ops&gt;&amp;/);
  assert.match(html, /Saved conversation/);
  assert.match(html, /data-fleet-group="private&quot;&lt;&amp;"/);
  assert.match(html, /3 more problems →/);
  assert.doesNotMatch(html, /Must not appear|Saved "<ops>|\b0 min\b|automatic restarts|No response/);
});

test('unnamed problem rows expose the platform or generic name, never an address', () => {
  const group_summary = summary({ problemCount: 2, problems: [
    { sessionGroup: 'lark:private-address', c4: { componentName: 'lark', sessionGroupName: 'raw-secret-address' }, reason: 'auth_failed' },
    { sessionGroup: 'private-unknown-address', reason: 'start_failed' },
  ] });
  const html = render(machine({ group_summary }), { t: key => ({ 'wb.platform.lark': 'Lark' }[key] || key) });
  assert.match(html, /class="wb-f-problem-name" title="Lark">Lark<\/b>/);
  assert.match(html, /class="wb-f-problem-name" title="Groups">Groups<\/b>/);
  assert.doesNotMatch(html, /raw-secret-address|title="lark:private-address"|>private-unknown-address</);
});

test('future no-response duration and restart signals render only when explicitly supplied', () => {
  const group_summary = summary({ counts: { no_response: 1, idle: 3 }, problemCount: 1,
    problems: [{ sessionGroup: 'future', displayName: 'Future signal', reason: 'no_response', durationSeconds: 245 }],
    autoRestarts: { count: 2 } });
  const html = render(machine({ group_summary }));
  assert.match(html, /1 no response/);
  assert.match(html, /wb-gbar-no_response/);
  assert.match(html, /No response 4 min/);
  assert.match(html, /2 automatic restarts in the last hour →/);
  assert.doesNotMatch(html, /All normal/);
});

test('problem and more clicks carry their machine and group without opening the generic machine link', () => {
  for (const self of [false, true]) for (const more of [false, true]) {
    const calls = [];
    const card = { dataset: { agent: 'remote fixture', ...(self ? { self: 'true' } : {}) } };
    const button = { dataset: more ? { group: 'problem-group' } : { fleetGroup: 'problem-group' },
      closest: selector => selector === '[data-agent]' ? card : null,
      hasAttribute: name => name === 'data-fleet-problems' && more };
    handleFleetClick({ target: { closest: selector => selector === '[data-fleet-group], [data-fleet-problems]' ? button : null },
      preventDefault: () => calls.push('prevented') }, {
      onGroup: target => calls.push(['group', target]), onProblems: target => calls.push(['problems', target]),
      onSelf: () => calls.push('self'), onRemote: () => calls.push('remote'),
    });
    assert.deepEqual(calls, ['prevented', [more ? 'problems' : 'group', { agent: 'remote fixture', self, group: 'problem-group' }]]);
  }
});
