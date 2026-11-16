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
  const calls = [], logged = [];
  const send = createNamingRequest({
    log: message => logged.push(message),
    zylosDir: ROOT,
    env: { HOME: '/fixture/home', ZYLOS_SESSION_GROUP: 'telegram:caller', ZYLOS_DIR: '/elsewhere' },
    readMode: () => mode,
    execute: async (file, args, options) => {
      calls.push({ file, args, options });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return { send, calls, logged };
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

// The child's failure as execFile reports it: the whole command line (with the prompt), install paths and a stack.
function childFailure({ code = 1, signal = null, killed = false, stdout = '' } = {}) {
  const message = `Command failed: ${process.execPath} ${CONTROL} enqueue --content ${PROMPT} --no-ack-suffix --group origin --json\n`
    + `Error: Cannot find module '${ROOT}/.claude/skills/comm-bridge/scripts/c4-db.js'\n`
    + '    at Function._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n    at Module._load (node:internal/modules/cjs/loader:1051:27)';
  return Object.assign(new Error(message), { code, signal, killed, stdout,
    stderr: `node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module '${ROOT}/x.js'\n    at Module._compile (node:internal/modules/cjs/loader:1364:14)` });
}

// Nothing the child printed reaches the API body; all of it reaches the service log.
function assertClean(body, label) {
  const text = JSON.stringify(body);
  for (const fragment of ['Command failed', '--content', 'c4-control', 'group-name.js', '请给 Dashboard', ROOT, '/fixture', 'node:internal',
    'Cannot find module', process.execPath]) {
    assert.equal(text.includes(fragment), false, `${label}: the API body has no ${JSON.stringify(fragment)}`);
  }
  assert.doesNotMatch(body.error.message, /(^|\n)\s*at /, `${label}: no stack line`);
  assert.match(body.error.code, /^[A-Z][A-Z0-9_]*$/, `${label}: an error code`);
}

test('a failed send command answers with a code and a fixed sentence; the command, prompt, paths and stack go to the log', async () => {
  const cases = [
    ['exit 1', childFailure(), { code: 'RESULT_UNKNOWN', message: 'Send command failed (exit 1)' }],
    ['timeout', childFailure({ code: null, signal: 'SIGTERM', killed: true }), { code: 'RESULT_UNKNOWN', message: 'Send command timed out' }],
    ['signal', childFailure({ code: null, signal: 'SIGKILL' }), { code: 'RESULT_UNKNOWN', message: 'Send command stopped (SIGKILL)' }],
    ['no start', childFailure({ code: 'ENOENT' }), { code: 'RESULT_UNKNOWN', message: 'Send command could not start' }],
  ];
  for (const [label, reply, error] of cases) {
    const { send, logged } = fixture({ reply });
    const body = await send();
    assert.deepEqual(body, { ok: false, unknown: true, sessionGroup: 'origin', error }, label);
    assertClean(body, label);
    assert.equal(logged.length, 1, `${label}: one log line`);
    assert.ok(logged[0].includes('RESULT_UNKNOWN') && logged[0].includes(reply.message) && logged[0].includes(reply.stderr),
      `${label}: the log keeps the original message and stderr`);
  }
});

test('C4 refusing the control keeps its code; its own message, which may carry paths, stays in the log', async () => {
  const refusal = { ok: false, error: { code: 'CONTROL_TARGET_REQUIRED', message: 'A control target is required when configuration cannot be read' } };
  const rejected = fixture({ reply: childFailure({ stdout: JSON.stringify(refusal) }) });
  const body = await rejected.send();
  assert.deepEqual(body, { ok: false, sessionGroup: 'origin', error: { code: 'CONTROL_TARGET_REQUIRED', message: 'C4 did not queue the naming prompt' } });
  assertClean(body, 'refused');
  assert.ok(rejected.logged[0].includes(refusal.error.message) && rejected.logged[0].includes('Command failed'), 'the log keeps C4\'s message and the child\'s');

  const pathCode = fixture({ reply: { stdout: JSON.stringify({ ok: false, error: { code: `${ROOT}/db`, message: `unable to open ${ROOT}/comm-bridge/c4.db` } }) } });
  const odd = await pathCode.send();
  assert.deepEqual(odd.error, { code: 'ENQUEUE_REJECTED', message: 'C4 did not queue the naming prompt' }, 'a code that is not a code is replaced');
  assertClean(odd, 'odd code');
  assert.match(pathCode.logged[0], /unable to open \/fixture\/zylos\/comm-bridge\/c4\.db/);
});

test('an unreadable or incomplete answer is unknown, never sent', async () => {
  const garbled = fixture({ reply: { stdout: `OK: enqueued control 7 at ${ROOT}` } });
  const body = await garbled.send();
  assert.deepEqual(body, { ok: false, unknown: true, sessionGroup: 'origin', error: { code: 'RESULT_UNKNOWN', message: 'Core returned no result envelope' } });
  assertClean(body, 'garbled');
  assert.match(garbled.logged[0], /OK: enqueued control 7/);

  const noId = fixture({ reply: { stdout: JSON.stringify({ ok: true, data: {} }) } });
  assert.deepEqual(await noId.send(), { ok: false, unknown: true, sessionGroup: 'origin',
    error: { code: 'RESULT_UNKNOWN', message: 'Core returned no control identifier' } });

  const sent = fixture();
  assert.deepEqual(await sent.send(), { ok: true, controlId: 41, sessionGroup: 'origin' });
  assert.deepEqual(sent.logged, [], 'a queued prompt logs nothing');
});
