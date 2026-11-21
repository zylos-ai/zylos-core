import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { getRuntime } from '../index.js';
import { matchHealthNoticeText } from '../../../../skills/activity-monitor/scripts/health-notice-match.js';

const text = (id, file) => fs.readFile(new URL(`./samples/${id}/${file}`, import.meta.url), 'utf8');
const json = async (id, file) => JSON.parse(await text(id, file));

async function healthRecording(t, id, name) {
  let manifest;
  try {
    manifest = await json(id, 'health/manifest.json');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!manifest?.files?.[name]) {
    t.skip(`Missing native recording: ${id}/health/${name}`);
    return null;
  }
  for (const field of ['program', 'version', 'recordedAt', 'how']) {
    assert.equal(typeof manifest[field], 'string', field);
    assert.ok(manifest[field], field);
  }
  return text(id, `health/${name}`);
}

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

for (const [id, file, fact] of [
  ['claude', 'rate-limit-screen.txt', 'rateLimit'],
  ['claude', 'auth-failure-screen.txt', 'authFailure'],
  ['claude', 'api-error-screen.txt', 'apiError'],
  ['codex', 'auth-failure-screen.txt', 'authFailure'],
]) {
  test(`${id} recorded pane shows ${fact}`, async t => {
    const pane = await healthRecording(t, id, file);
    if (pane === null) return;
    const result = (await getRuntime(id)).health.screen.match(pane);
    assert.equal(result[fact].detected, true);
    if (id === 'codex') assert.equal(result.rateLimit.detected, false);
  });
}

test('Claude recorded HTTP 400 StopFailure has a prompt ID and recognizable API error text', async () => {
  const { hooks, health } = await getRuntime('claude');
  const record = hooks.normalize(await json('claude', 'hooks/stop-failure.json'), 'StopFailure');
  assert.equal(Boolean(record.prompt_id), health.hookHealth.hookFailureHasPromptId);
  assert.equal(health.screen.match(record.last_assistant_message).apiError.detected, true);
});

test('Claude recorded authentication StopFailure matches the prompt ID contract', async t => {
  const payload = await healthRecording(t, 'claude', 'auth-failure.json');
  if (payload === null) return;
  const { hooks, health } = await getRuntime('claude');
  const record = hooks.normalize(JSON.parse(payload), 'StopFailure');
  assert.equal(record.error, 'authentication_failed');
  assert.equal(Boolean(record.prompt_id), health.hookHealth.hookFailureHasPromptId);
});

test('agy recorded HTTP 401 Stop normalizes to StopFailure without a prompt ID', async () => {
  const { hooks, health } = await getRuntime('agy');
  const record = hooks.normalize(await json('agy', 'hooks/stop-auth-error.json'), 'Stop');
  assert.equal(record.hook_event_name, 'StopFailure');
  assert.equal(record.error, 'authentication_failed');
  assert.equal(Boolean(record.prompt_id), health.hookHealth.hookFailureHasPromptId);
});

test('Claude recorded weekly limit StopFailure selects the quota notice', async t => {
  const native = await healthRecording(t, 'claude', 'weekly-limit.json');
  if (native === null) return;
  const { health } = await getRuntime('claude');
  assert.equal(matchHealthNoticeText(JSON.parse(native), health.noticeRules)?.kind, 'quota');
});
