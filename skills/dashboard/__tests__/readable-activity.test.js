import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/lib/store.js';
import { CodexRolloutCollector } from '../src/lib/runtime/codex/collector.js';
import { summarizeCommandActivity } from '../src/lib/runtime/codex/command-activity.js';
import { buildSteps } from '../src/lib/chat/activity.js';
import { projectTimelineActivity } from '../src/lib/workbench/timeline-events.js';
import { eventRows, eventTypesFor, recentRows } from '../public/js/wb/timeline-rows.js';
import { mergeActivitySteps } from '../public/js/wb/activity-labels.js';

const readCommand = path => ({ type: 'CommandExecution', parsed_cmd: [{ type: 'read', path }] });

test('Claude commentary needs a later tool in the same turn on both activity surfaces', () => {
  const at = Date.parse('2026-01-01T12:00:00Z');
  const events = [
    { type: 'assistant_message', summary: 'Previous final reply' },
    { type: 'input_dequeue' },
    { type: 'assistant_message', summary: '  Checking\n the files ', meta: { message_id: 'message' } },
    { type: 'pre_tool_use', meta: { tool_use_id: 'call', tool_name: 'Read' } },
    { type: 'assistant_message', summary: 'Current final reply' },
  ].map((event, seq) => ({ at, seq, runtime: 'claude', run: 'run', session: 'session', meta: {}, ...event }));
  const timeline = events.filter(event => eventTypesFor('all', 'plain').includes(event.type)).map(event => {
    const row = { event_type: event.type, event_seq: event.seq, timestamp: new Date(event.at).toISOString(),
      runtime: event.runtime, run_id: event.run, session_id: event.session, summary: event.summary, metadata: event.meta };
    return { ...row, activity: projectTimelineActivity(row) };
  });
  const chat = buildSteps(events, { now: at });
  assert.deepEqual(chat.steps.filter(step => step.kind === 'commentary').map(step => step.text), ['Checking the files']);
  assert.equal(timeline[2].activity, null);
  assert.equal(eventRows(timeline.slice(0, 3), { plain: true }).some(row => row.event.activity?.kind === 'commentary'), false);
  const loaded = eventRows([...timeline.slice(3), ...timeline.slice(0, 3)], { plain: true });
  assert.deepEqual(loaded.flatMap(({ event }) => event.activity?.kind === 'commentary' ? [event.activity.text] : []), ['Checking the files']);
  assert.deepEqual(recentRows(timeline, { level: 'plain' }).map(({ newest }) => newest.kind), ['tool', 'commentary']);
});

test('conversation steps and group event projections share Codex activity labels', () => {
  const command_activity = ['.claude/skills/comm-bridge/SKILL.md', 'README.md'].reduce((summary, name) =>
    summarizeCommandActivity(readCommand(`/workspace/${name}`), summary), undefined);
  const meta = { tool_name: 'exec', call_id: 'call' };
  const event = { runtime: 'codex', type: 'tool_call', meta, at: 1 };
  const result = { ...event, type: 'tool_result', at: 2, meta: { ...meta, command_activity } };
  const group = projectTimelineActivity({ runtime: result.runtime, event_type: result.type, metadata: result.meta });
  const chat = buildSteps([event, result], { now: 2 });
  assert.deepEqual(group.label, { key: 'skill', arg: 'comm-bridge', count: 2, more: 'files' });
  assert.deepEqual(chat.steps[0].label, group.label);
});

test('Codex activity drops shell arguments, search text, unsafe basenames and heredoc content', () => {
  const secret = 'sk-test-XXXX';
  const url = 'https://demo:password@example.invalid/script.py';
  const heredoc = `TOKEN=${secret} curl ${url} <<EOF\n${secret}\nEOF`;
  const directory = '/private/dir';
  const parts = [
    { type: 'unknown', cmd: `git status --token=${secret} ${url}` },
    { type: 'unknown', cmd: heredoc },
    { type: 'read', path: `${directory}/${secret}.txt` },
    { type: 'search', query: secret, cmd: `rg ${secret} ${url}` },
    { type: 'unknown', cmd: `python ${url}` },
  ];
  const script = { type: 'unknown', cmd: `python3 ${directory}/run.py` };
  const summarizePart = part => summarizeCommandActivity({ parsed_cmd: [part] });
  for (const part of [...parts, script]) {
    const json = JSON.stringify(summarizePart(part));
    for (const fragment of [secret, 'https://', 'demo:password', 'example.invalid', directory]) {
      assert.ok(!json.includes(fragment), `Activity exposed a private fragment for a ${part.type} command`);
    }
  }
  assert.deepEqual(summarizePart(script).first, { key: 'runScript', arg: 'run.py' });
  assert.deepEqual(summarizeCommandActivity({ command: heredoc }), { first: null, count: 1, allReads: false });
});

test('activity keeps a failed step separate from consecutive successes with the same label', () => {
  const step = { kind: 'tool', label: { key: 'searchFiles' } };
  const first = { ...step, status: 'done', start: 0, end: 1000 };
  const second = { ...step, status: 'done', start: 1000, end: 3000 };
  const failed = { ...step, status: 'failed', start: 3000, end: 4000 };
  assert.deepEqual(mergeActivitySteps([first, second, failed]), [{ ...first, count: 2, duration: 3000 }, failed]);
});

test('collector appends structured command activity only on the final result, without changing the call', t => {
  const root = mkdtempSync(join(tmpdir(), 'readable-activity-'));
  const file = join(root, 'fixture.jsonl');
  const store = new Store(join(root, 'fixture.db'));
  t.after(() => { store.db.close(); rmSync(root, { recursive: true, force: true }); });
  const collector = new CodexRolloutCollector(store, { zylosDir: root });
  const mapping = { transcript_path: file, session_group: 'origin', session_id: 'fixture', run_id: 'run' };
  const envelope = (type, payload) => JSON.stringify({ type, timestamp: '2026-01-01T12:00:00Z', payload }) + '\n';
  writeFileSync(file, envelope('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'outer', input: 'fixture' }));
  collector.collectMapping(mapping);
  const calls = () => store.db.prepare("SELECT metadata FROM runtime_events WHERE event_type = 'tool_call'").all().map(row => JSON.parse(row.metadata));
  assert.equal(calls()[0].command_activity, undefined);
  appendFileSync(file, envelope('event_msg', { type: 'item_completed', item: { ...readCommand('/fixture/message.txt'),
    id: 'inner', command: 'ignored', cwd: '/fixture', aggregated_output: 'ignored', exit_code: 0 } }));
  collector.collectMapping(mapping);
  assert.equal(calls().length, 1);
  assert.equal(calls()[0].command_activity, undefined);
  appendFileSync(file, envelope('response_item', { type: 'custom_tool_call_output', call_id: 'outer', output: 'Script completed' }));
  collector.collectMapping(mapping);
  assert.equal(calls()[0].command_activity, undefined);
  const result = store.db.prepare("SELECT metadata FROM runtime_events WHERE event_type = 'tool_result'").get();
  assert.deepEqual(JSON.parse(result.metadata).command_activity, { first: { key: 'read', arg: 'message.txt' }, count: 1, allReads: true });
});
