import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderStateSkeleton } from '../state-format.js';
import { projectC4Content } from '../../../comm-bridge/scripts/c4-content-projection.js';
import { escapeText } from '../../../comm-bridge/scripts/c4-query-format.js';
import { CONTENT_PREFIX, parseC4Content } from '../../../comm-bridge/scripts/c4-content-schema.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const row = (content, id = 7) => ({ id, content, timestamp: '2026-11-07T00:00:00Z', sessionGroup: 'demo:a', channel: 'demo', endpointId: 'room' });
const render = rows => renderStateSkeleton({ scope: 'demo:a', syncedAt: '2026-11-07T00:00:00Z', absorbed: { runId: 'run', rows } });

test('working state projects complete envelopes before escaping and the local body budget', () => {
  const envelope = structuredClone(fixtures.valid.find(item => item.name === 'markdown').envelope);
  envelope.blocks[0].data.text = 'HOST_ONLY_' + 'x'.repeat(2000);
  envelope.fallbackText = 'readable summary';
  const content = '[C4-JSON]\n' + JSON.stringify(envelope);
  const rows = [row(content)], before = JSON.stringify(rows);
  const text = render(rows);
  assert.ok(text.includes(escapeText(projectC4Content(content, { c4Id: 7 }))));
  assert.equal(text.includes('HOST_ONLY_'), false);
  assert.equal(text.includes('[C4-JSON]'), false);
  assert.equal(text.includes('截断'), false);
  assert.equal(JSON.stringify(rows), before);
});

test('working state contains only invalid-content references for marked damage and preserves ordinary text', () => {
  const content = '[C4-JSON]\n{"HOST_ONLY_DAMAGED":true';
  assert.ok(render([row(content)]).includes('[C4 content invalid; c4_id=7]'));
  assert.equal(render([row(content)]).includes('HOST_ONLY_DAMAGED'), false);
  const plain = 'plain text\nwith \\ escapes';
  assert.ok(render([row(plain)]).includes(escapeText(plain)));
  assert.ok(render([row('')]).includes('（无正文）'));
});

// Actual memory-state formatter and shared fixtures; run for View/projection or
// memory body-budget changes. Pure calls only, no memory store or runtime IO.
test('valid degraded and overdeep Views leave memory projection byte-identical', () => {
  const shared = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));
  const view = structuredClone(shared.views.find(item => item.name === 'balanced_columns').view);
  const unknown = { ...structuredClone(view), schemaVersion: 99 };
  const overdeep = structuredClone(view); overdeep.nodes[1].extra = { b: { c: 'VIEW_ONLY_SECRET' } };
  for (const long of [false, true]) {
    const envelope = structuredClone(shared.message);
    envelope.blocks[0].data.text = 'CONTENT_ONLY_SECRET' + 'x'.repeat(30000);
    if (long) envelope.fallbackText = 'Visible summary ' + '中'.repeat(1000);
    const content = CONTENT_PREFIX + JSON.stringify(envelope);
    const expected = render([row(content)]);
    for (const [layout, valid] of [[view, true], [unknown, false], [overdeep, false]]) {
      const withView = CONTENT_PREFIX + JSON.stringify({ ...envelope, metadata: { view: layout } });
      const parsed = parseC4Content(withView);
      assert.equal(parsed.kind, 'envelope');
      assert.equal(parsed.view !== null, valid);
      assert.equal(render([row(withView)]), expected);
      assert.equal(expected.includes('CONTENT_ONLY_SECRET'), false);
      assert.equal(expected.includes('VIEW_ONLY_SECRET'), false);
      assert.equal(expected.includes('"nodes"'), false);
      if (parsed.viewError) assert.equal(expected.includes(parsed.viewError), false);
    }
    assert.equal(expected.includes('截断，全文见 #7'), long);
  }
});

// Actual state formatter after attachment schema changes; no memory-store IO.
test('working state preserves attachment filenames and IDs while omitting source and storage metadata', () => {
  const shared = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/attachment-blocks.json', import.meta.url), 'utf8'));
  const content = CONTENT_PREFIX + JSON.stringify(shared.mixed), rows = [row(content)];
  const before = JSON.stringify(rows), text = render(rows);
  assert.ok(text.includes(escapeText(projectC4Content(content, { c4Id: 7 }))));
  for (const visible of ['diagram.png', 'att_image', 'report.pdf', 'att_file']) assert.ok(text.includes(visible));
  for (const hidden of ['ATTACHMENT_STORAGE_METADATA', 'ATTACHMENT_SOURCE_PATH', 'sourcePath', 'nameSnapshot', '[C4-JSON]']) {
    assert.equal(text.includes(hidden), false, hidden);
  }
  assert.equal(JSON.stringify(rows), before);
});
