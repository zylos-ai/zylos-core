import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceiveArgs } from '../c4-receive.js';
import { fixture } from './c4-v2-test-helpers.js';

test('receive task name option and store metadata validation use structured arguments', t => {
  const f = fixture(t), taskName = 'Daily report';
  const parsed = parseReceiveArgs(['--no-reply', '--core-source', 'scheduler', '--task-name', taskName, '--content', 'message']);
  assert.equal(parsed.taskName, taskName); assert.equal(parsed.coreSource, 'scheduler');
  assert.throws(() => parseReceiveArgs(['--no-reply', '--task-name']), { code: 'INVALID_ARGS' });
  for (const options of [{ coreSource: 'unrecognized' }, { taskName: 42 }]) {
    assert.throws(() => f.store.insertConversation('in', 'system', null, 'message', options), { code: 'INVALID_ARGS' });
  }
  const row = f.store.insertConversation('in', 'system', null, 'message', { coreSource: 'scheduler', taskName });
  assert.equal(row.core_source, 'scheduler'); assert.equal(row.task_name, taskName);
});
