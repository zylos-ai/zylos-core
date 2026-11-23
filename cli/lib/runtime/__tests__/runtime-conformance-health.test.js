import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { getRuntime } from '../index.js';

const text = (id, file) => fs.readFile(new URL(`./samples/${id}/${file}`, import.meta.url), 'utf8');
const json = async (id, file) => JSON.parse(await text(id, file));

for (const id of ['claude', 'codex']) {
  test(`${id} recorded idle pane contains no health failure`, async () => {
    const { health } = await getRuntime(id);
    const result = health.screen.match(await text(id, 'input/empty.txt'));
    assert.deepEqual(result, {
      rateLimit: { detected: false },
      authFailure: { detected: false },
      apiError: { detected: false },
    });
  });
}

test('Claude recorded HTTP 400 StopFailure has a prompt ID', async () => {
  const { hooks, health } = await getRuntime('claude');
  const record = hooks.normalize(await json('claude', 'hooks/stop-failure.json'), 'StopFailure');
  assert.equal(Boolean(record.prompt_id), health.hookHealth.hookFailureHasPromptId);
});

test('agy recorded HTTP 401 Stop normalizes to StopFailure without a prompt ID', async () => {
  const { hooks, health } = await getRuntime('agy');
  const record = hooks.normalize(await json('agy', 'hooks/stop-auth-error.json'), 'Stop');
  assert.equal(record.hook_event_name, 'StopFailure');
  assert.equal(record.error, 'authentication_failed');
  assert.equal(Boolean(record.prompt_id), health.hookHealth.hookFailureHasPromptId);
});
