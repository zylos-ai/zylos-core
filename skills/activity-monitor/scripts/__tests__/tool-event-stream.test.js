import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import {
  createToolEventStreamState,
  readToolEventsIncrementalFromStream,
  rotateToolEventStream,
} from '../tool-event-stream.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-event-stream-test-'));
const eventsFile = path.join(tmpDir, 'tool-events.jsonl');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

function appendEvent(filePath, event) {
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

describe('tool-event-stream', () => {
  it('keeps the rotated file around for drain and creates a fresh active file', () => {
    appendEvent(eventsFile, { ts: 1000, event: 'pre_tool', session_id: 's1' });

    const state = rotateToolEventStream({
      filePath: eventsFile,
      nowMs: 1500,
    });

    assert.equal(fs.existsSync(eventsFile), true);
    assert.equal(fs.readFileSync(eventsFile, 'utf8'), '');
    assert.equal(fs.existsSync(`${eventsFile}.old`), true);
    assert.equal(state.last_rotation_at, 1500);
    assert.equal(state.rotated_drain.path, `${eventsFile}.old`);
    assert.equal(state.rotated_drain.offset > 0, true);
  });

  it('reads late writes from the rotated file before draining it', () => {
    appendEvent(eventsFile, { ts: 1000, event: 'pre_tool', session_id: 's1', tool: 'WebFetch' });

    let streamState = createToolEventStreamState(eventsFile);
    let activeTail = '';
    let rotatedTail = '';
    let arrivalSeq = 0;

    let firstRead = readToolEventsIncrementalFromStream({
      filePath: eventsFile,
      streamState,
      activeTail,
      rotatedTail,
      arrivalSeq,
      nowMs: 1100,
    });
    streamState = firstRead.streamState;
    activeTail = firstRead.activeTail;
    rotatedTail = firstRead.rotatedTail;
    arrivalSeq = firstRead.arrivalSeq;
    assert.equal(firstRead.events.length, 1);

    streamState = rotateToolEventStream({
      filePath: eventsFile,
      nowMs: 1200,
    });

    appendEvent(`${eventsFile}.old`, { ts: 1250, event: 'post_tool', session_id: 's1', tool: 'WebFetch' });
    appendEvent(eventsFile, { ts: 1300, event: 'prompt', session_id: 's1' });

    const secondRead = readToolEventsIncrementalFromStream({
      filePath: eventsFile,
      streamState,
      activeTail,
      rotatedTail,
      arrivalSeq,
      nowMs: 1300,
      drainQuietMs: 5000,
    });

    assert.deepEqual(
      secondRead.events.map((event) => [event.event, event.ts]),
      [['post_tool', 1250], ['prompt', 1300]]
    );
    assert.equal(secondRead.streamState.rotated_drain.path, `${eventsFile}.old`);
  });

  it('removes the rotated drain file after a quiet period with no further growth', () => {
    appendEvent(eventsFile, { ts: 1000, event: 'pre_tool', session_id: 's1' });

    let streamState = rotateToolEventStream({
      filePath: eventsFile,
      nowMs: 1000,
    });

    let result = readToolEventsIncrementalFromStream({
      filePath: eventsFile,
      streamState,
      activeTail: '',
      rotatedTail: '',
      arrivalSeq: 0,
      nowMs: 1500,
      drainQuietMs: 2000,
    });
    streamState = result.streamState;
    assert.equal(fs.existsSync(`${eventsFile}.old`), true);
    assert.notEqual(streamState.rotated_drain, null);

    result = readToolEventsIncrementalFromStream({
      filePath: eventsFile,
      streamState,
      activeTail: result.activeTail,
      rotatedTail: result.rotatedTail,
      arrivalSeq: result.arrivalSeq,
      nowMs: 3200,
      drainQuietMs: 2000,
    });

    assert.equal(fs.existsSync(`${eventsFile}.old`), false);
    assert.equal(result.streamState.rotated_drain, null);
  });
});
