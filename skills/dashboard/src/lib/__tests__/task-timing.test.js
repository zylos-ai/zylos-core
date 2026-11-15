import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskTiming } from '../task-timing.js';

test('task timing preserves return values, exceptions and promise identity', () => {
  let now = 0;
  const timing = new TaskTiming({ now: () => now });
  assert.equal(timing.run('value', () => { now += 2; return 42; }), 42);
  const error = new Error('expected');
  assert.throws(() => timing.run('throw', () => { now += 3; throw error; }), e => e === error);
  const promise = Promise.resolve(7);
  assert.equal(timing.run('promise', () => promise), promise);
  assert.deepEqual(timing.drain().map(({ name, max_ms }) => ({ name, max_ms })), [
    { name: 'throw', max_ms: 3 }, { name: 'value', max_ms: 2 }, { name: 'promise', max_ms: 0 }
  ]);
});

test('async continuations are timed without counting awaited wall time', async () => {
  let now = 0;
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const timing = new TaskTiming({ now: () => now }).start();
  try {
    const result = timing.run('refresh', async () => {
      now += 7;
      await gate;
      now += 11;
      return 'done';
    });
    now += 5_000; // Time passes outside any attributed callback.
    resume();
    assert.equal(await result, 'done');
    const [entry] = timing.drain();
    assert.equal(entry.name, 'refresh');
    assert.equal(entry.total_ms, 18);
    assert.equal(entry.max_ms, 11);
  } finally {
    timing.stop();
  }
});

test('nested named tasks do not double count elapsed time', () => {
  let now = 0;
  const timing = new TaskTiming({ now: () => now });
  timing.run('outer', () => {
    now += 2;
    timing.run('inner', () => { now += 9; });
    now += 3;
  });
  const entries = timing.drain();
  assert.equal(entries.find(e => e.name === 'inner').total_ms, 9);
  assert.equal(entries.find(e => e.name === 'outer').total_ms, 5);
});

test('retained names are bounded and the longest blockers survive overflow', () => {
  let now = 0;
  const timing = new TaskTiming({ now: () => now, maxTasks: 3 });
  for (let i = 1; i <= 100; i++) timing.run(`task-${i}`, () => { now += i; });
  assert.equal(timing.records.size, 3);
  assert.deepEqual(timing.drain().map(e => e.name), ['task-100', 'task-99', 'task-98']);
  assert.deepEqual(timing.drain(), []);
});

test('labels are bounded and safe for warning lines', () => {
  const timing = new TaskTiming();
  timing.run('x\n'.repeat(100), () => {});
  const [entry] = timing.drain();
  assert.equal(entry.name.length, 120);
  assert.doesNotMatch(entry.name, /[\r\n]/);
});

test('timer descendants remain attributed across samples without attributing unrelated work', async () => {
  let now = 0;
  const timing = new TaskTiming({ now: () => now }).start();
  try {
    const pending = timing.run('timer-task', async () => {
      now += 2;
      await new Promise(resolve => setTimeout(() => { now += 4; resolve(); }, 5));
      now += 8;
    });
    assert.equal(timing.drain()[0].total_ms, 2);
    now += 1_000;
    await pending;
    assert.equal(timing.drain()[0].total_ms, 12);
    await Promise.resolve();
    now += 100; // The caller's own continuation is not a task descendant.
    assert.deepEqual(timing.drain(), []);
  } finally {
    timing.stop();
  }
});

test('rejected async tasks retain attribution and stop releases collected records', async () => {
  let now = 0;
  const timing = new TaskTiming({ now: () => now }).start();
  const failure = new Error('async failure');
  try {
    await assert.rejects(timing.run('rejecting-task', async () => {
      await Promise.resolve();
      now += 6;
      throw failure;
    }), error => error === failure);
    assert.equal(timing.drain()[0].total_ms, 6);
    timing.run('later', () => { now += 3; });
  } finally {
    timing.stop();
  }
  assert.deepEqual(timing.drain(), []);
});
