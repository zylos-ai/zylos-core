import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fleetGroupSummary, sanitizeFleetGroupSummary } from '../skills/dashboard/src/lib/workbench/fleet-summary.js';
import { setInstanceZone, instanceZoneReady, formatZoned } from '../skills/dashboard/public/js/wb/instance-zone.js';
import { FleetPoller } from '../skills/dashboard/src/lib/fleet-poller.js';
import { objectResponse } from '../skills/dashboard/__tests__/fixtures/fleet-object-api.js';

const browserDescriptors = new URL('../skills/dashboard/public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});
const { renderFleetAttention, renderAgentFleetHtml } = await import('../skills/dashboard/public/js/agent-fleet.js');

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
  const document = { createElement: tag => new Node(tag, document), documentElement: { dataset: { detail: 'plain' } } };
  const root = new Node('div', document);
  const reason = '<img src=x onerror=alert(1)>';
  renderFleetAttention(root, [{ kind: 'data_unreadable', group: 'ops', reasonCode: reason }, { kind: 'future' }],
    key => key);
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].dataset.fleetGroup, 'ops');
  assert.equal(root.children[0].children[1].textContent, 'ops · wb.flags.unreadable');
  document.documentElement.dataset.detail = 'technical';
  renderFleetAttention(root, [{ kind: 'data_unreadable', group: 'ops', reasonCode: reason }]);
  assert.equal(root.children[0].children[1].textContent, 'ops · wb.flags.unreadable · ' + reason);
  assert.equal(root.children[0].children[0].children.length, 0);
  for (const locale of ['en', 'zh']) {
    const pack = JSON.parse(fs.readFileSync(new URL('../skills/dashboard/public/i18n/wb.' + locale + '.json', import.meta.url)));
    for (const level of ['plain', 'technical']) {
      document.documentElement.dataset.detail = level;
      renderFleetAttention(root, [{ kind: 'data_unreadable', group: 'ops', displayName: 'Operations room', reasonCode: 'identity_mismatch' }],
        key => pack[key] ?? key);
      const detail = root.children[0].children[1].textContent;
      assert.ok(detail.includes('Operations room'));
      assert.ok(detail.includes(pack['wb.flags.unreadable']));
      assert.equal(detail.includes('identity_mismatch'), level === 'technical');
    }
  }
  const until = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(instanceZoneReady(), false);
  renderFleetAttention(root, [{ kind: 'rate_limited', runtime: 'codex', until }],
    (key, values) => JSON.stringify({ key, ...values }));
  const pending = JSON.parse(root.children[0].children[0].textContent);
  assert.equal(pending.key, 'wb.attention.rate_limited_unknown');
  assert.equal(pending.time, '', 'no provisional UTC clock before metadata arrives');
  setInstanceZone('Asia/Singapore');
  assert.equal(instanceZoneReady(), true);
  renderFleetAttention(root, [{ kind: 'rate_limited', runtime: 'codex', until },
    { kind: 'rate_limited', runtime: 'codex', until: 0 }], (key, values) => JSON.stringify({ key, ...values }));
  const known = JSON.parse(root.children[0].children[0].textContent);
  const unknown = JSON.parse(root.children[1].children[0].textContent);
  assert.equal(known.key, 'wb.attention.rate_limited');
  assert.equal(known.runtime, 'Codex');
  assert.equal(known.time, formatZoned(until * 1000, undefined, { hour: '2-digit', minute: '2-digit' }));
  setInstanceZone(undefined);
  assert.equal(instanceZoneReady(), true, 'older metadata without a zone enables the UTC fallback');
  renderFleetAttention(root, [{ kind: 'rate_limited', runtime: 'codex', until }],
    (key, values) => JSON.stringify({ key, ...values }));
  const fallback = JSON.parse(root.children[0].children[0].textContent);
  assert.equal(fallback.key, 'wb.attention.rate_limited');
  assert.equal(fallback.time, formatZoned(until * 1000, undefined, { hour: '2-digit', minute: '2-digit' }, 'UTC'));
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
