import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStateHeader, validateStateDocument, renderStateSkeleton } from '../state-format.js';

const scope = 'telegram:g-123';
const syncedAt = '2026-10-19T05:30:02Z';
const base = { scope, syncedAt };
const row = (id, content = 'hello', extra = {}) => ({ id, content, timestamp: '2026-10-19 05:30:02', sessionGroup: scope, channel: 'telegram', endpointId: '-123|msg:91', ...extra });
const render = (rows, options = {}) => renderStateSkeleton({ ...base, absorbed: { runId: 'run-1', followUp: 'group', rows }, ...options });
const entry = text => text.split('\n').find(line => line.startsWith('- #'));
const empty = { valid: false, scope: null, coverage: null, inboxCommitted: [] };

test('W1: header-only reader and full document validator have distinct contracts', () => {
  const text = renderStateSkeleton(base);
  assert.deepEqual(parseStateHeader(text, { scope }), { valid: true, scope, coverage: null, inboxCommitted: [] });
  assert.equal(validateStateDocument(text, { scope }), true);
  for (const title of ['# Working State', '## Headline', '## In Progress', '## Pending', '## Commitments']) {
    const incomplete = text.replace(title, 'missing');
    assert.equal(parseStateHeader(incomplete, { scope }).valid, true);
    assert.equal(validateStateDocument(incomplete, { scope }), false);
  }
  const segment = '20261019T053002123Z';
  const committed = text.replace('coverage= ', 'coverage=42 ').replace('inbox_committed= ', `inbox_committed=${segment},${segment}-1 `);
  assert.deepEqual(parseStateHeader(committed, { scope }), { valid: true, scope, coverage: 42, inboxCommitted: [segment, segment + '-1'] });
  assert.equal(validateStateDocument(text + '正文'.repeat(100000), { scope }), true);
});

test('W1: malformed first lines degrade without scanning later lines or throwing', () => {
  const good = renderStateSkeleton(base);
  const bad = [null, undefined, 42, '', '\n' + good, 'old format\n' + good,
    good.replace('v1', 'v2'), good.replace('scope=' + scope, 'scope=bad/../group'),
    good.replace(' | coverage= ', ' '), good.replace(' | coverage= ', ' | coverage= | coverage= '),
    good.replace('coverage= ', 'coverage=1.5 '), good.replace('coverage= ', 'coverage=NaN '),
    good.replace('synced_at=' + syncedAt, 'synced_at=2026-10-19T05:30:02'),
    good.replace('inbox_committed= ', 'inbox_committed=../foo '),
    good.replace('inbox_committed= ', 'inbox_committed=20261019T053002123Z,20261019T053002123Z ')];
  for (const text of bad) assert.deepEqual(parseStateHeader(text, { scope }), empty);
  assert.deepEqual(parseStateHeader(good, { scope: '*' }), empty);
  assert.equal(parseStateHeader(good.replaceAll('\n', '\r\n'), { scope }).valid, true);
});

test('IB48 A/B: 64KiB body truncates locally; all 1000 sorted IDs survive deterministically', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row(1000 - i, i === 0 ? 'x'.repeat(65536) : `body ${i}`));
  const text = render(rows), lines = text.split('\n').filter(line => line.startsWith('- #'));
  assert.equal(lines.length, 1000);
  assert.deepEqual(lines.map(line => Number(/^- #(\d+) /.exec(line)[1])), Array.from({ length: 1000 }, (_, i) => i + 1));
  assert.match(lines.at(-1), /x{509}…（截断，全文见 #1000）$/);
  assert.equal(text, render(rows));
  assert.equal(rows[0].id, 1000); // no mutation of the caller's snapshot
  assert.match(text, /共 1000 条（#1–#1000）/);
  assert.equal(validateStateDocument(text, { scope }), true);
});

test('IB48 C: empty rows omit block; empty source group uses caller scope origin without route prefix', () => {
  assert.doesNotMatch(render([]), /切换来信/);
  assert.doesNotMatch(renderStateSkeleton(base), /切换来信/);
  const rows = [row(1, '', { sessionGroup: '' })];
  const text = render(rows, { scope: 'origin' });
  assert.match(text, /scope=origin/);
  assert.match(entry(text), /\[telegram -123\|msg:91\] （无正文）$/);
  assert.match(entry(render([row(1)], { scope: '*' })), /\[telegram:g-123 telegram /);
  assert.match(entry(render(rows, { scope: '*' })), /\[telegram -123/);
});

test('IB48 D/E: UTF-8 route/body byte bounds preserve whole characters', () => {
  const line = entry(render([row(1, '汉'.repeat(400), { endpointId: '路'.repeat(234) })]));
  const route = /\[([^\]]+)\]/.exec(line)[1];
  assert.ok(Buffer.byteLength(route) <= 128);
  assert.match(route, /…$/);
  assert.equal(line.split('] ')[1], '汉'.repeat(169) + '…（截断，全文见 #1）');
  assert.doesNotMatch(line, /�/);
});

test('IB48 F: controls and backslashes render as reversible single-line tokens', () => {
  const content = '\\\n\r\t\x00\x1f\x7f\u0085\u2028\u2029';
  const line = entry(render([row(1, content, { endpointId: content })]));
  const expected = '\\\\\\n\\r\\t\\x00\\x1f\\x7f\\u0085\\u2028\\u2029';
  assert.ok(line.endsWith('] ' + expected));
  assert.ok(line.includes('[telegram ' + expected + ']'));
  assert.doesNotMatch(line, /[\x00-\x1f\x7f\u0085\u2028\u2029]/);
});

test('IB48 G: escaped 512/513 bytes and truncation beside escape boundaries', () => {
  assert.ok(entry(render([row(1, 'a'.repeat(510) + '\n')])).endsWith('a'.repeat(510) + '\\n'));
  assert.ok(entry(render([row(1, 'a'.repeat(511) + '\n')])).endsWith('a'.repeat(509) + '…（截断，全文见 #1）'));
  for (const character of ['\n', '\\', '\x00', '\u2028', '🙂']) {
    const body = 'a'.repeat(508) + character + 'ending';
    assert.ok(entry(render([row(1, body)])).endsWith('a'.repeat(508) + '…（截断，全文见 #1）'));
  }
});

test('IB48 timestamp conversion is UTC, second precision, supplied syncedAt retained', () => {
  const line = entry(render([row(1, 'hello', { timestamp: '2026-10-19T13:30:02.123+08:00' })]));
  assert.match(line, /2026-10-19T05:30:02Z/);
  const text = renderStateSkeleton({ scope: '*', syncedAt: '2026-10-19T13:30:02+08:00' });
  assert.match(text, /synced_at=2026-10-19T13:30:02\+08:00/);
});

// A P2-1 / IB-48: freeze the entire rendered document, including Pending placement.
test('IB-48 absorbed title and rows appear at the start of Pending in the full document', () => {
  assert.equal(render([row(2), row(1)]), `<!-- zylos-state v1 | scope=telegram:g-123 | synced_at=2026-10-19T05:30:02Z | coverage= | inbox_committed= -->

# Working State

## Headline

## In Progress

## Pending

- [切换来信] run=run-1 共 2 条（#1–#2）；回复：c4-send.js --absorbed-reply run-1 <id>；全文：c4-fetch.js --absorbed --run-id run-1 --id <id>
- #1 2026-10-19T05:30:02Z [telegram -123|msg:91] hello
- #2 2026-10-19T05:30:02Z [telegram -123|msg:91] hello

## Commitments
`);
});
