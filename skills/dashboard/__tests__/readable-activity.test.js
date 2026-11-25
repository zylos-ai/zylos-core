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

const readCommand = path => ({ type: 'CommandExecution', parsed_cmd: [{ type: 'read', path }] });

test('conversation steps and group event projections share Codex activity labels', () => {
  const command_activity = ['SKILL.md', 'README.md'].reduce((summary, name) =>
    summarizeCommandActivity(readCommand(`/workspace/${name}`), summary), undefined);
  const meta = { tool_name: 'exec', call_id: 'call', command_activity };
  const event = { runtime: 'codex', type: 'tool_call', meta, at: 1 };
  const group = projectTimelineActivity({ runtime: event.runtime, event_type: event.type, metadata: meta });
  const chat = buildSteps([event], { now: 2 });
  assert.deepEqual(group.label, { key: 'viewFile', arg: 'SKILL.md', count: 2, more: 'files' });
  assert.deepEqual(chat.steps[0].label, group.label);
});

test('Codex activity drops shell arguments, search text, unsafe basenames and heredoc content', () => {
  const secret = 'sk-test-XXXX';
  const url = 'https://demo:password@example.invalid/script.py';
  const payload = { parsed_cmd: [
    { type: 'unknown', cmd: `git status --token=${secret} ${url}` },
    { type: 'unknown', cmd: `TOKEN=${secret} curl ${url} <<EOF\n${secret}\nEOF` },
    { type: 'read', path: `/fixtures/${secret}.txt` },
    { type: 'search', query: secret, cmd: `rg ${secret} ${url}` },
    { type: 'unknown', cmd: `python ${url}` },
  ] };
  assert.deepEqual(summarizeCommandActivity(payload), { first: { key: 'codeStatus' }, count: 5, allReads: false });
  assert.deepEqual(summarizeCommandActivity({ command: payload.parsed_cmd[1].cmd }), { first: null, count: 1, allReads: false });
});

test('collector enriches an existing Codex exec event with only structured command activity', t => {
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
  assert.deepEqual(calls()[0].command_activity, { first: { key: 'viewFile', arg: 'message.txt' }, count: 1, allReads: true });
});
