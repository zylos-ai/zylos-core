import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderStateSkeleton } from '../state-format.js';
import { projectC4Content } from '../../../comm-bridge/scripts/c4-content-projection.js';
import { escapeText } from '../../../comm-bridge/scripts/c4-query-format.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const row = (content, id = 7) => ({ id, content, timestamp: '2026-11-07T00:00:00Z', sessionGroup: 'demo:a', channel: 'demo', endpointId: 'room' });
const render = rows => renderStateSkeleton({ scope: 'demo:a', syncedAt: '2026-11-07T00:00:00Z', absorbed: { runId: 'run', rows } });

test('working state projects complete envelopes before escaping and the local body budget', () => {
  const envelope = structuredClone(fixtures.valid.find(item => item.name === 'markdown').envelope);
  envelope.blocks[0].data.text = 'HOST_ONLY_' + 'x'.repeat(2000);
  envelope.fallbackText = 'readable summary';
  const content = '[C4-CONTENT]\n' + JSON.stringify(envelope);
  const rows = [row(content)], before = JSON.stringify(rows);
  const text = render(rows);
  assert.ok(text.includes(escapeText(projectC4Content(content, { c4Id: 7 }))));
  assert.equal(text.includes('HOST_ONLY_'), false);
  assert.equal(text.includes('[C4-CONTENT]'), false);
  assert.equal(text.includes('截断'), false);
  assert.equal(JSON.stringify(rows), before);
});

test('working state contains only invalid-content references for marked damage and preserves ordinary text', () => {
  const content = '[C4-CONTENT]\n{"HOST_ONLY_DAMAGED":true';
  assert.ok(render([row(content)]).includes('[C4 content invalid; c4_id=7]'));
  assert.equal(render([row(content)]).includes('HOST_ONLY_DAMAGED'), false);
  const plain = 'plain text\nwith \\ escapes';
  assert.ok(render([row(plain)]).includes(escapeText(plain)));
  assert.ok(render([row('')]).includes('（无正文）'));
});
