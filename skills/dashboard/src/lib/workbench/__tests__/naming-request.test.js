import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createNamingRequest, NAME_PROMPT, ORIGINAL_GROUP_NAME_PATH, namePromptText } from '../naming-request.js';

// Module boundary: the real naming request with the instance's session mode and the c4-control child injected.
// No process, database or Core state is touched; each case records the exact command it would run.
const ROOT = '/fixture/zylos';
const CONTROL = path.join(ROOT, '.claude/skills/comm-bridge/scripts/c4-control.js');
const PROMPT = namePromptText(path.join(ROOT, '.claude/skills/dashboard/scripts/group-name.js'), NAME_PROMPT, ORIGINAL_GROUP_NAME_PATH);

// A missing session_mode key reads as undefined; only an omitted `mode` option means multi.
function fixture(options = {}) {
  const { reply = { stdout: JSON.stringify({ ok: true, data: { id: 41 } }) } } = options;
  const mode = Object.hasOwn(options, 'mode') ? options.mode : 'multi';
  const calls = [];
  const send = createNamingRequest({
    zylosDir: ROOT,
    env: { HOME: '/fixture/home', ZYLOS_SESSION_GROUP: 'telegram:caller', ZYLOS_DIR: '/elsewhere' },
    readMode: () => mode,
    execute: async (file, args, options) => {
      calls.push({ file, args, options });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return { send, calls };
}

test('the naming prompt keeps its words and substitutes only the first CLI path', () => {
  const script = '/tmp/fixture/.claude/skills/dashboard/scripts/group-name.js';
  const text = namePromptText(script, NAME_PROMPT, ORIGINAL_GROUP_NAME_PATH);
  assert.equal(text.replace(script, ORIGINAL_GROUP_NAME_PATH), NAME_PROMPT);
  assert.match(text, /group-name.js set <组键> "名字"/);
  assert.equal(namePromptText('/tmp/$&/group-name.js', ORIGINAL_GROUP_NAME_PATH + ' · ' + ORIGINAL_GROUP_NAME_PATH, ORIGINAL_GROUP_NAME_PATH),
    '/tmp/$&/group-name.js · ' + ORIGINAL_GROUP_NAME_PATH, 'literal replacement characters survive');
  assert.throws(() => namePromptText(script, 'no path here', ORIGINAL_GROUP_NAME_PATH), /name_prompt_path_missing/);
});

test('multi mode queues one unacknowledged control for the origin group', async () => {
  const { send, calls } = fixture({ mode: 'multi' });
  assert.deepEqual(await send(), { ok: true, controlId: 41, sessionGroup: 'origin' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args, [CONTROL, 'enqueue', '--content', PROMPT, '--no-ack-suffix', '--group', 'origin', '--json']);
  assert.equal(calls[0].options.env.ZYLOS_DIR, ROOT, 'the child addresses this Dashboard instance');
  assert.equal(Object.hasOwn(calls[0].options.env, 'ZYLOS_SESSION_GROUP'), false, 'no inherited caller group reaches C4');
});

test('single mode leaves the target to C4, which addresses the only session', async () => {
  for (const mode of ['single', undefined]) {
    const { send, calls } = fixture({ mode });
    assert.deepEqual(await send(), { ok: true, controlId: 41, sessionGroup: null });
    assert.deepEqual(calls[0].args, [CONTROL, 'enqueue', '--content', PROMPT, '--no-ack-suffix', '--json']);
  }
});

test('a rejected or unreadable enqueue is reported with its reason, never as sent', async () => {
  const rejected = fixture({ reply: Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ ok: false,
    error: { code: 'CONTROL_TARGET_REQUIRED', message: 'A control target is required in multi or during transition' } }) }) });
  assert.deepEqual(await rejected.send(), { ok: false, sessionGroup: 'origin',
    error: { code: 'CONTROL_TARGET_REQUIRED', message: 'A control target is required in multi or during transition' } });

  const silent = fixture({ reply: Object.assign(new Error('timed out'), { stdout: '' }) });
  assert.deepEqual(await silent.send(), { ok: false, unknown: true, sessionGroup: 'origin',
    error: { code: 'RESULT_UNKNOWN', message: 'timed out' } });

  const garbled = fixture({ reply: { stdout: 'OK: enqueued control 7' } });
  assert.equal((await garbled.send()).error.code, 'RESULT_UNKNOWN');

  const noId = fixture({ reply: { stdout: JSON.stringify({ ok: true, data: {} }) } });
  assert.deepEqual(await noId.send(), { ok: false, unknown: true, sessionGroup: 'origin',
    error: { code: 'RESULT_UNKNOWN', message: 'Core returned no control identifier' } });
});
