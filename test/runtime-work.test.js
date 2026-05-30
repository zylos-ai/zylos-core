import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { closeDb, getDb } from '../skills/runtime-work/scripts/db.js';
import {
  appendEvent,
  closeOut,
  createWork,
  getWork,
  getWorkEvents,
  transitionWork
} from '../skills/runtime-work/scripts/api.js';

let tempDir = null;

function makeWorkInput(overrides = {}) {
  return {
    sourceSystem: 'conversation',
    sourceId: `conv-${Date.now()}`,
    kind: 'human_message',
    state: 'queued',
    ...overrides
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-work-'));
  process.env.RUNTIME_WORK_DB_PATH = path.join(tempDir, 'runtime-work.db');
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.RUNTIME_WORK_DB_PATH;
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('runtime-work module', () => {
  test('initializes runtime_work and runtime_work_event tables', () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('runtime_work', 'runtime_work_event')
      ORDER BY name
    `).all();

    expect(rows.map((row) => row.name)).toEqual(['runtime_work', 'runtime_work_event']);
  });

  test('createWork creates queued work with created event', () => {
    const work = createWork(makeWorkInput());
    expect(work).toBeTruthy();
    expect(work.state).toBe('queued');
    expect(work.source_system).toBe('conversation');
    expect(work.kind).toBe('human_message');

    const events = getWorkEvents(work.work_id);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe('created');
  });

  test('transitionWork supports queued -> running -> done and records transitions', () => {
    const work = createWork(makeWorkInput());

    const running = transitionWork(work.work_id, { state: 'running', summary: 'claimed' });
    expect(running.state).toBe('running');
    expect(running.started_at).toBeTruthy();

    const done = transitionWork(work.work_id, { state: 'done' });
    expect(done.state).toBe('done');
    expect(done.finished_at).toBeTruthy();

    const events = getWorkEvents(work.work_id);
    const transitionEvents = events.filter((evt) => evt.event_type === 'state_transition');
    expect(transitionEvents.length).toBe(2);
    expect(transitionEvents[0].event_json.from).toBe('queued');
    expect(transitionEvents[0].event_json.to).toBe('running');
    expect(transitionEvents[1].event_json.from).toBe('running');
    expect(transitionEvents[1].event_json.to).toBe('done');
  });

  test('appendEvent adds custom event rows', () => {
    const work = createWork(makeWorkInput());
    appendEvent(work.work_id, 'note', { detail: 'manual-note' });

    const events = getWorkEvents(work.work_id);
    const note = events.find((evt) => evt.event_type === 'note');
    expect(note).toBeTruthy();
    expect(note.event_json.detail).toBe('manual-note');
  });

  test('closeOut updates terminal status and writes close_out event', () => {
    const work = createWork(makeWorkInput());
    transitionWork(work.work_id, { state: 'running' });

    const closed = closeOut(work.work_id, {
      status: 'done',
      summary: 'completed',
      closeoutJson: { result: 'ok' },
      artifactRefs: ['https://example.com/artifact/1']
    });

    expect(closed.state).toBe('done');
    expect(closed.closeout_status).toBe('done');
    expect(closed.closeout_summary).toBe('completed');
    expect(closed.closeout_json.result).toBe('ok');
    expect(closed.artifact_refs).toEqual(['https://example.com/artifact/1']);
    expect(closed.finished_at).toBeTruthy();

    const persisted = getWork(work.work_id);
    expect(persisted.closeout_status).toBe('done');
    expect(persisted.closeout_summary).toBe('completed');

    const events = getWorkEvents(work.work_id);
    expect(events[events.length - 1].event_type).toBe('close_out');
  });
});
