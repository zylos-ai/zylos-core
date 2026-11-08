import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/lib/store.js';
import { Sanitizer } from '../src/lib/sanitizer.js';
import { codexToolOutputFailed } from '../src/lib/codex-tool-outcome.js';
import { CodexRolloutCollector } from '../src/lib/collectors/codex-rollout-collector.js';
import { ConversationCollector } from '../src/lib/collectors/conversation-collector.js';
import { groupMainTranscript } from '../src/lib/collectors/usage-transcripts.js';
import { recordGroupInterrupt } from '../src/lib/chat/activity.js';

// Local temporary SQLite and files only; no runtime, Core or network.
function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-data-'));
  const store = new Store(path.join(dir, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

test('a failed Claude tool call gets its own summary and keeps no error text in it', () => {
  const sanitizer = new Sanitizer('/isolated/zylos');
  const failed = sanitizer.sanitizeHookPayload('PostToolUseFailure', { tool_name: 'Read', tool_use_id: 'u1',
    tool_input: { file_path: '/isolated/zylos/memory/state.md' }, error: 'secret failure text' });
  assert.equal(failed.summary, 'Read failed: memory/state.md');
  assert.equal(failed.metadata.tool_use_id, 'u1');
  assert.ok(!JSON.stringify(failed).includes('secret failure text'));
});

test('a command step records whether its text is the agent description or a summarized command', () => {
  const sanitizer = new Sanitizer('/isolated/zylos');
  const described = sanitizer.sanitizeHookPayload('PreToolUse', { tool_name: 'Bash',
    tool_input: { command: 'rm -rf /tmp/x', description: 'Remove the old lock file' } });
  assert.equal(described.metadata.tool_detail, 'Remove the old lock file');
  assert.equal(described.metadata.detail_source, 'description');
  const bare = sanitizer.sanitizeHookPayload('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls -la /tmp' } });
  assert.equal(bare.metadata.detail_source, 'command');
  const read = sanitizer.sanitizeHookPayload('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/isolated/zylos/a.md' } });
  assert.equal(read.metadata.detail_source, undefined);
});

test('Codex tool output failure reading matches exit codes and error markers', () => {
  for (const output of ['Process exited with code 1\nboom', '{"exit_code": 2}', '{"isError": true}', 'Process exited with code 127'])
    assert.equal(codexToolOutputFailed(output), true, output);
  for (const output of ['Process exited with code 0\nok', '{"exit_code": 0}', 'plain text', '', undefined, null])
    assert.equal(codexToolOutputFailed(output), false, String(output));
});

function rollout(dir, name, events) {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, events.map((event, index) => JSON.stringify({
    timestamp: `2026-11-08T10:00:0${index}.000Z`, ...event })).join('\n') + '\n');
  return file;
}

test('Codex tool results carry only a success or failure flag, and other groups keep their assistant words', async t => {
  const { dir, store } = tmpStore(t);
  const mappings = [['origin', true], ['dashboard:a', false]].map(([group]) => ({
    transcript_path: rollout(dir, group.replace(':', '-'), [
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: `${group}-ok`, arguments: '{"cmd":"ls"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: `${group}-ok`, output: 'Process exited with code 0\nsecret-ok' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: `${group}-bad`, arguments: '{"cmd":"false"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: `${group}-bad`, output: 'Process exited with code 1\nsecret-bad' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Words of ${group}` }] } },
    ]), session_id: `${group}-session`, session_group: group, run_id: `${group}-run` }));
  const transcripts = { snapshot: { listKnown: true }, currentOriginMapping: () => mappings[0],
    isOriginCurrent: row => row.session_group === 'origin', async collect(runtime, callback) {
      let written = 0;
      for (const mapping of mappings) written += (await callback(mapping, mapping.session_group === 'origin')).written;
      return written;
    } };
  for (const mapping of mappings) store.insertUsageTranscript({ ...mapping, runtime: 'codex' }, new Date().toISOString());
  const collector = new CodexRolloutCollector(store, { modelPrices: {} }, { transcripts });
  const notified = [];
  collector._onEvent = event => notified.push(event);
  await collector.collect();
  const results = store.queryEvents({ types: ['tool_result'], limit: 10 });
  assert.equal(results.length, 4);
  for (const row of results) {
    assert.equal(row.metadata.outcome, row.metadata.call_id.endsWith('-bad') ? 'failed' : 'succeeded');
    assert.ok(!JSON.stringify(row).includes('secret-'), 'tool output is never stored');
  }
  const words = store.queryEvents({ types: ['assistant_message'], limit: 10 });
  assert.deepEqual(words.map(row => [row.session_group, row.summary]).sort(),
    [['dashboard:a', 'Words of dashboard:a'], ['origin', 'Words of origin']]);
  assert.equal(notified.filter(event => event.event_type === 'assistant_message').length, 1);
  assert.equal(notified.find(event => event.event_type === 'assistant_message').session_group, 'origin');
});

test('Claude main transcripts of other groups keep assistant words without reaching the Origin state', async t => {
  const { dir, store } = tmpStore(t);
  const line = (id, sessionId, text) => JSON.stringify({ type: 'assistant', uuid: id, requestId: id, sessionId,
    timestamp: '2026-11-08T10:00:00.000Z', message: { id: `m-${id}`, model: 'claude-example',
      content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const files = {
    origin: [path.join(dir, 'origin.jsonl'), line('o1', 'origin-s', 'Origin words')],
    group: [path.join(dir, 'group.jsonl'), line('g1', 'group-s', 'Group words')],
    child: [path.join(dir, 'child.jsonl'), line('c1', 'group-s', 'Subagent words')],
    oldOrigin: [path.join(dir, 'old.jsonl'), line('x1', 'old-s', 'Old origin words')],
  };
  for (const [file, text] of Object.values(files)) fs.writeFileSync(file, text + '\n');
  const mappings = [
    [{ transcript_path: files.origin[0], session_id: 'origin-s', session_group: 'origin', run_id: 'r0' }, true],
    [{ transcript_path: files.group[0], session_id: 'group-s', session_group: 'dashboard:a', run_id: 'r1' }, false],
    [{ transcript_path: files.child[0], session_id: 'group-s', session_group: 'dashboard:a', run_id: 'r1', parent_path: files.group[0] }, false],
    [{ transcript_path: files.oldOrigin[0], session_id: 'old-s', session_group: 'origin', run_id: 'old' }, false],
  ];
  const transcripts = { async collect(runtime, callback) {
    let written = 0;
    for (const [mapping, current] of mappings) written += callback({ ...mapping, byte_offset: 0 }, current).written;
    return written;
  } };
  const collector = new ConversationCollector(store, { zylosDir: dir, runtimeModelPrices: { claude: {} } }, { transcripts });
  const notified = [];
  collector._onEvent = event => notified.push(event);
  await collector.collect();
  const words = store.queryEvents({ types: ['assistant_message'], limit: 10 });
  assert.deepEqual(words.map(row => [row.session_group, row.summary]).sort(),
    [['dashboard:a', 'Group words'], ['origin', 'Origin words']]);
  assert.equal(words.find(row => row.session_group === 'dashboard:a').duration_ms, null);
  assert.deepEqual(notified.map(event => event.summary), ['Origin words']);
  assert.equal(groupMainTranscript(mappings[1][0]), true);
  for (const index of [0, 2, 3]) assert.equal(groupMainTranscript(mappings[index][0]), false);
  assert.equal(groupMainTranscript({ session_group: null }), false);
});

test('a Dashboard interrupt is stored as a group runtime event', t => {
  const { store } = tmpStore(t);
  const result = recordGroupInterrupt(store, { sessionGroup: 'dashboard:a', runId: 'r1', sessionId: 's1', controlId: 7,
    at: Date.parse('2026-11-08T10:00:05.000Z') });
  assert.equal(result.inserted, true);
  const [row] = store.queryEvents({ types: ['dashboard_interrupt'], limit: 5 });
  assert.equal(row.session_group, 'dashboard:a'); assert.equal(row.run_id, 'r1'); assert.equal(row.session_id, 's1');
  assert.equal(row.timestamp, '2026-11-08T10:00:05.000Z'); assert.equal(row.metadata.control_id, 7);
  assert.equal(recordGroupInterrupt(store, { sessionGroup: '' }), null);
});
