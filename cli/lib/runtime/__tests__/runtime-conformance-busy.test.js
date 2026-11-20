import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { getRuntime } from '../index.js';

async function recordedTranscript(id) {
  const directory = new URL(`./samples/${id}/busy/`, import.meta.url);
  const { sessionId, startedAt, files } = JSON.parse(await fs.readFile(new URL('manifest.json', directory), 'utf8'));
  assert.ok(Object.hasOwn(files, 'transcript.jsonl'));
  assert.equal(typeof sessionId, 'string');
  assert.ok(sessionId);
  assert.ok(Number.isFinite(startedAt));
  const source = await fs.readFile(new URL('transcript.jsonl', directory), 'utf8');
  const records = source.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 3);
  const { busy } = await getRuntime(id);
  return { parse: busy.transcript.createParser({ sessionId, startedAt }), records };
}

test('Claude transcript records report dequeue, main response and tool completion', async () => {
  const { parse, records: [dequeue, output, result] } = await recordedTranscript('claude');
  const outputAt = Date.parse(output.timestamp);
  assert.deepEqual(parse(dequeue), { dequeueAt: Date.parse(dequeue.timestamp) });
  assert.deepEqual(parse(output), { responseAt: outputAt, mainActionAt: outputAt });
  const toolUseId = result.message.content[0].tool_use_id;
  assert.equal(typeof toolUseId, 'string');
  assert.deepEqual(parse(result), { toolResultIds: [toolUseId] });
});

test('Codex transcript records count responses only after binding the recorded session', async () => {
  const { parse, records: [meta, output, call] } = await recordedTranscript('codex');
  assert.deepEqual(parse(meta), {});
  assert.deepEqual(parse(output), { responseAt: Date.parse(output.timestamp) });
  assert.deepEqual(parse(call), { responseAt: Date.parse(call.timestamp) });

  assert.deepEqual(parse({ ...meta, payload: { ...meta.payload, id: 'other-session' } }), {});
  assert.deepEqual(parse(output), {});
  assert.deepEqual(parse(call), {});
});

test('Antigravity statusLine records preserve idle and running task evidence', async () => {
  const directory = new URL('./samples/agy/busy/', import.meta.url);
  const { files } = JSON.parse(await fs.readFile(new URL('manifest.json', directory), 'utf8'));
  const { busy } = await getRuntime('agy');
  for (const [file, expected] of Object.entries({
    'idle.json': { idle: true, tasksRunning: false },
    'background-task.json': { idle: true, tasksRunning: true },
    'running-subagent.json': { idle: true, tasksRunning: true },
    'after-escape.json': { idle: true, tasksRunning: false },
  })) {
    assert.ok(Object.hasOwn(files, file));
    const sample = JSON.parse(await fs.readFile(new URL(file, directory), 'utf8'));
    assert.deepEqual(busy.statuslineActivity(sample), expected, file);
  }
});
