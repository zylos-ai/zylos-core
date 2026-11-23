import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { setInstanceZone, instanceZoneReady, formatZoned } from '../skills/dashboard/public/js/wb/instance-zone.js';

const browserDescriptors = new URL('../skills/dashboard/public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});
const { renderFleetAttention } = await import('../skills/dashboard/public/js/agent-fleet.js');

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
