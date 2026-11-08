import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, allNodes } from './fixtures/workbench-dom.js';
import { eventChip, eventTypesFor, showsEvent, newestFirst, mergeRepeats, recentRows,
  plainEventTypes, lifecycleEventTypes, toolEventTypes } from '../public/js/wb/timeline-rows.js';
import { repeatRow } from '../public/js/wb/detail-overview.js';
import { chipNames } from '../public/js/wb/detail-timeline.js';

// Direct product imports with an injected DOM; no I/O, timers or child processes.
// Run for timeline classification, ordering or repeat-merging changes.
const t = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '');
const at = seconds => new Date(Date.parse('2026-11-08T10:00:00.000Z') + seconds * 1000).toISOString();
const ev = (type, seconds, seq, extra = {}) => ({ event_type: type, timestamp: at(seconds), event_seq: seq, ...extra });
const row = event => ({ at: Date.parse(event.timestamp), event });

test('only events with a plain label get a filter chip; diagnostics and unknown codes get none', () => {
  for (const type of ['release', 'pool_sample', 'runtime_health:recovered', 'unknown', 'made_up_code']) {
    assert.equal(eventChip({ event_type: type }), null, `${type} is technical detail, not lifecycle`);
    assert.equal(plainEventTypes.includes(type), false);
  }
  for (const type of ['session_start', 'user_prompt_submit', 'stop', 'permission_request', 'subagent_start', 'wait_health', 'crash_detected']) {
    assert.equal(eventChip({ event_type: type }), 'lifecycle', type);
  }
  for (const type of ['pre_tool_use', 'post_tool_use', 'post_tool_failure']) assert.equal(eventChip({ event_type: type }), 'tools', type);
  assert.deepEqual([...toolEventTypes, ...lifecycleEventTypes].sort(), [...plainEventTypes].sort(), 'every plain event has exactly one chip');
  assert.ok(plainEventTypes.length <= 100, 'the server accepts at most 100 types in one filter');
});

test('the server is asked for plain events in plain view and for every type in technical view', () => {
  assert.deepEqual(eventTypesFor('all', 'plain'), plainEventTypes);
  assert.equal(eventTypesFor('all', 'technical'), null);
  for (const level of ['plain', 'technical']) {
    assert.deepEqual(eventTypesFor('tools', level), toolEventTypes);
    assert.deepEqual(eventTypesFor('lifecycle', level), lifecycleEventTypes);
    assert.deepEqual(eventTypesFor('messages', level), []);
  }
});

test('unlisted events show only in technical view with every chip on', () => {
  const all = new Set(chipNames), count = chipNames.length;
  const release = { event_type: 'release' }, stop = { event_type: 'stop' };
  assert.equal(showsEvent(release, { chips: all, chipCount: count, level: 'technical' }), true);
  assert.equal(showsEvent(release, { chips: all, chipCount: count, level: 'plain' }), false);
  assert.equal(showsEvent(release, { chips: new Set(['tools', 'lifecycle']), chipCount: count, level: 'technical' }), false);
  assert.equal(showsEvent(stop, { chips: new Set(['lifecycle']), chipCount: count, level: 'plain' }), true);
  assert.equal(showsEvent(stop, { chips: new Set(['tools']), chipCount: count, level: 'technical' }), false);
});

test('rows read newest first, and events at the same moment keep their recorded order reversed', () => {
  const rows = [row(ev('a', 1, 1)), row(ev('b', 3, 2)), row(ev('c', 3, 3)), row(ev('d', 2, 4))];
  assert.deepEqual(newestFirst(rows).map(item => item.event.event_type), ['c', 'b', 'd', 'a']);
  assert.deepEqual(rows.map(item => item.event.event_type), ['a', 'b', 'c', 'd'], 'the input is not reordered in place');
});

test('consecutive identical events merge with their count and both ends; tools, messages and breaks keep rows apart', () => {
  const rows = newestFirst([
    row(ev('stop', 1, 1)),
    ...Array.from({ length: 4 }, (_, i) => row(ev('release', 2 + i, 2 + i))),
    row(ev('pre_tool_use', 6, 6, { metadata: { tool_name: 'Bash' } })),
    row(ev('pre_tool_use', 7, 7, { metadata: { tool_name: 'Read' } })),
    row(ev('release', 8, 8)),
    { at: Date.parse(at(9)), message: { direction: 'in', timestamp: at(9) } },
    { at: Date.parse(at(10)), message: { direction: 'in', timestamp: at(10) } },
  ]);
  const groups = mergeRepeats(rows);
  assert.deepEqual(groups.map(group => [group.newest.event?.event_type ?? 'message', group.count]),
    [['message', 1], ['message', 1], ['release', 1], ['pre_tool_use', 1], ['pre_tool_use', 1], ['release', 4], ['stop', 1]]);
  const releases = groups[5];
  assert.equal(releases.newest.event.timestamp, at(5));
  assert.equal(releases.oldest.event.timestamp, at(2));
});

test('a merged row shows the newest event once with how many times and from when to when', () => {
  const document = createDocument();
  const [group] = recentRows(Array.from({ length: 600 }, (_, i) => ev('release', i, i + 1, { category: 'diagnostic' })));
  assert.equal(group.count, 600);
  const node = repeatRow(document, group, { level: 'technical', t });
  const short = value => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  assert.equal(node.classList.contains('wb-ev-merged'), true);
  const repeat = allNodes(node).find(child => child.classList.contains('wb-ev-rep'));
  assert.equal(repeat.textContent, t('wb.timeline.repeated', { count: 600, from: short(at(0)), to: short(at(599)) }));
  assert.equal(repeat.title, `${at(0)} – ${at(599)}`, 'technical tooltips keep the raw times');
  assert.equal(allNodes(node).filter(child => child.tagName === 'TIME').length, 1, 'one row, one time column');
  const single = repeatRow(document, recentRows([ev('stop', 1, 1)])[0], { level: 'plain', t });
  assert.equal(allNodes(single).some(child => child.classList.contains('wb-ev-rep')), false);
});
