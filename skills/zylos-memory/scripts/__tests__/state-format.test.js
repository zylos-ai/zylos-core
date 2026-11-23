import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStateHeader, validateStateDocument, renderStateSkeleton, inboxSegmentName } from '../state-format.js';

const scope = 'telegram:g-123';
const syncedAt = '2026-10-19T05:30:02Z';
const base = { scope, syncedAt };
const row = (id, content = 'hello', extra = {}) => ({ id, content, timestamp: '2026-10-19 05:30:02', sessionGroup: scope, channel: 'telegram', endpointId: '-123|msg:91', ...extra });
const render = (rows, options = {}) => renderStateSkeleton({ ...base, absorbed: { runId: 'run-1', followUp: 'group', rows }, ...options });

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

test('A/B: 64KiB body truncates locally; all 1000 sorted IDs survive deterministically', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row(1000 - i, i === 0 ? 'x'.repeat(65536) : `body ${i}`));
  const text = render(rows), lines = text.split('\n').filter(line => line.startsWith('- #'));
  assert.equal(lines.length, 1000);
  assert.deepEqual(lines.map(line => Number(/^- #(\d+) /.exec(line)[1])), Array.from({ length: 1000 }, (_, i) => i + 1));
  assert.match(lines.at(-1), /x{509}… \(truncated; full text #1000\)$/);
  assert.equal(text, render(rows));
  assert.equal(rows[0].id, 1000); // no mutation of the caller's snapshot
  assert.match(text, /count=1000 \(#1–#1000\)/);
  assert.equal(validateStateDocument(text, { scope }), true);
});

// A / freeze the entire rendered document, including Pending placement.
test('absorbed title and rows appear at the start of Pending in the full document', () => {
  assert.equal(render([row(2), row(1)]), `<!-- zylos-state v1 | scope=telegram:g-123 | synced_at=2026-10-19T05:30:02Z | coverage= | inbox_committed= -->

# Working State

## Headline

## In Progress

## Pending

- [Mode-switch messages] run=run-1 count=2 (#1–#2); reply: c4-send.js --absorbed-reply run-1 <id>; full text: c4-fetch.js --absorbed --run-id run-1 --id <id>
- #1 2026-10-19T05:30:02Z [telegram -123|msg:91] hello
- #2 2026-10-19T05:30:02Z [telegram -123|msg:91] hello

## Commitments
`);
});

test('inbox segment names match a complete filename and only positive suffixes', () => {
  const segment = '20261019T053002123Z';
  for (const id of [segment, `${segment}-1`, `${segment}-12`]) {
    assert.equal(inboxSegmentName.exec(`inbox.${id}.md`)?.[1], id);
  }
  assert.equal(inboxSegmentName.test(`inbox.${segment}.md.bak`), false);
  assert.equal(inboxSegmentName.test(`inbox.${segment}-0.md`), false);
  assert.equal(inboxSegmentName.test(`inbox.${segment}-01.md`), false);
  const zeroSuffixHeader = renderStateSkeleton(base).replace('inbox_committed= ', `inbox_committed=${segment}-0 `);
  assert.equal(parseStateHeader(zeroSuffixHeader, { scope }).valid, false);
});
