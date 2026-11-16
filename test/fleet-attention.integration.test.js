import assert from 'node:assert/strict';
import test from 'node:test';
import { fleetGroupSummary, sanitizeFleetGroupSummary } from '../skills/dashboard/src/lib/workbench/fleet-summary.js';
import { renderFleetAttention, renderAgentFleetHtml } from '../skills/dashboard/public/js/agent-fleet.js';
import { FleetPoller } from '../skills/dashboard/src/lib/fleet-poller.js';
import { objectResponse } from '../skills/dashboard/__tests__/fixtures/fleet-object-api.js';

// In-memory product projections and fake HTTP responses only. Run when changing
// Fleet attention contracts/rendering/polling; unrelated channel adapters may skip.
test('Fleet shares channel, runtime and group diagnostic attention without replacing primary counts', () => {
  const result = fleetGroupSummary({ mode: 'multi', listKnown: true,
    rows: [{ sessionGroup: 'ops', presence: 'running', state: { kind: 'idle' },
      flags: { unreadable: { reasons: ['C4_READ_FAILED'] } } }],
    instance: { runtimeHealth: { codex: { health: 'rate_limited' } }, services: { channels: [
      { channel: 'lark', lastSendFailed: true, consecutiveFailures: 2, restarts10m: 3 },
      { channel: 'telegram', lastSendFailed: false, restarts10m: 2 },
    ] } } });
  assert.equal(result.counts.idle, 1);
  assert.equal(result.counts.error, 0);
  assert.deepEqual(result.attention.map(item => item.kind).sort(),
    ['channel_send_failed', 'channel_restarting', 'data_unreadable', 'rate_limited'].sort());
  assert.deepEqual(result.attention.find(item => item.kind === 'data_unreadable'),
    { kind: 'data_unreadable', group: 'ops', displayName: 'ops', reasonCode: 'C4_READ_FAILED' });
  assert.deepEqual(sanitizeFleetGroupSummary(result), result);
  const polluted = structuredClone(result);
  polluted.attention.push({ kind: 'unsupported', secret: 'discard' });
  polluted.attention[0].secret = 'discard';
  assert.deepEqual(sanitizeFleetGroupSummary(polluted), result);
  assert.doesNotMatch(renderAgentFleetHtml({ agents: [{ name: 'local', state: 'IDLE', session_mode: 'multi', group_summary: result }] }), /All normal/);
});

test('Fleet diagnostic reasons use text nodes and preserve group navigation', () => {
  class Node {
    constructor(tag, ownerDocument) { this.tag = tag; this.ownerDocument = ownerDocument; this.children = []; this.dataset = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren() { this.children = []; }
    set innerHTML(_) { assert.fail('diagnostic text must not be assigned as HTML'); }
  }
  const document = { createElement: tag => new Node(tag, document) };
  const root = new Node('div', document);
  const reason = '<img src=x onerror=alert(1)>';
  renderFleetAttention(root, [{ kind: 'data_unreadable', group: 'ops', reasonCode: reason }, { kind: 'future' }],
    (key, values) => key + ' ' + values.reason);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].dataset.fleetGroup, 'ops');
  assert.equal(root.children[0].children[1].textContent, 'ops · ' + reason);
  assert.equal(root.children[0].children[0].children.length, 0);
  renderFleetAttention(root, [{ kind: 'rate_limited', runtime: 'codex', until: Math.floor(Date.now() / 1000) + 3600 },
    { kind: 'rate_limited', runtime: 'codex', until: 0 }], (key, values) => JSON.stringify({ key, ...values }));
  const known = JSON.parse(root.children[0].children[0].textContent);
  const unknown = JSON.parse(root.children[1].children[0].textContent);
  assert.equal(known.key, 'wb.attention.rate_limited');
  assert.equal(known.runtime, 'Codex');
  assert.ok(known.time.length > 0);
  assert.equal(unknown.key, 'wb.attention.rate_limited_unknown');
  assert.equal(unknown.time, '');
  renderFleetAttention(root, []);
  assert.equal(root.children.length, 0);
});

test('Fleet fetch includes offline start failures and preserves a failed diagnostic read', async () => {
  for (const readable of [true, false]) {
    const requests = [];
    const poller = new FleetPoller({}, { fetch: async url => {
      requests.push(url);
      if (url.includes('/api/groups/offline')) return new Response(JSON.stringify({ rows: [
        { id: 'failed-offline', flags: { startFailed: { count: 2 } } }
      ] }), { status: readable ? 200 : 503 });
      return objectResponse(url, { instance: { session_mode: { sessionMode: 'multi' } },
        counts: { offline: { total: 1, startFailed: 1 } } });
    } });
    const response = await poller._fetchState({ base_url: 'http://fixture.invalid' }, 'fixture');
    const state = await response.json();
    assert.ok(requests.some(url => url.endsWith('/api/groups/offline?flag=startFailed')));
    const attention = state.group_summary.attention;
    assert.ok(attention.some(item => readable ? item.kind === 'start_failed' && item.group === 'failed-offline'
      : item.kind === 'data_unreadable' && item.source === 'offline_start_failed'));
  }
});
