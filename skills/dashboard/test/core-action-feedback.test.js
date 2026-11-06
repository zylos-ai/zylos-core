import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import * as timerPromises from 'node:timers/promises';
import { promisify } from 'node:util';
import { formatActionResult } from '../public/js/action-result.js';

const dictionary = locale => JSON.parse(fs.readFileSync(new URL(`../public/i18n/${locale}.json`, import.meta.url), 'utf8'));
const translate = (messages, key, params = {}) => (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));

function localized(result, expectedKey) {
  assert.equal(typeof result.messageKey, 'string');
  assert.ok(result.messageKey.length > 0);
  if (expectedKey) assert.equal(result.messageKey, expectedKey);
  for (const locale of ['en', 'zh']) {
    const messages = dictionary(locale);
    assert.ok(Object.hasOwn(messages, result.messageKey), `${locale}: missing ${result.messageKey}`);
    assert.equal(typeof messages[result.messageKey], 'string');
    assert.ok(messages[result.messageKey].length > 0);
    const rendered = formatActionResult(result, (key, params) => translate(messages, key, params));
    assert.ok(rendered.startsWith(translate(messages, result.messageKey, result.messageParams)));
    if (locale === 'zh' && result.message) assert.notEqual(rendered, result.message, `${locale}: raw message fallback`);
  }
  return result;
}

// Integration boundary: real Dashboard action dispatcher with a Core handler stub.
// Run when action de-duplication or request forwarding changes; skip unrelated UI.
// The caller isolates HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR. Clock/Core calls are
// injected; no database, tmux, PM2, runtime, network or child process is opened.
test('session action de-duplication ignores only top-level run and session identity', async t => {
  let now = 100000;
  const calls = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.module('../src/lib/core-actions.js', { namedExports: {
    handleCoreAction: async (action, body) => { calls.push({ action, body: structuredClone(body) }); return { ok: true, messageKey: 'result.interrupt_submitted' }; },
  } });
  const { handleAction } = await import('../src/lib/actions.js?identity-dedup');
  const config = { zylosDir: process.env.ZYLOS_DIR };
  for (const action of ['restart-session', 'interrupt', 'chop-chop']) {
    await t.test(action, async () => {
      now += 10000;
      const before = calls.length;
      const firstBody = { sessionGroup: 'origin', runId: null, sessionId: null, intent: action };
      const nextBody = { ...firstBody, runId: 'new-run', sessionId: 'new-session' };
      assert.equal((await handleAction(action, firstBody, config)).ok, true);
      now += 100;
      assert.equal((await handleAction(action, nextBody, config)).error, 'duplicate_request');
      assert.equal(calls.length, before + 1);
      assert.deepEqual(calls.at(-1), { action, body: firstBody });
      assert.deepEqual(firstBody, { sessionGroup: 'origin', runId: null, sessionId: null, intent: action }, 'de-duplication must not mutate the caller body');
      now += 1901;
      assert.equal((await handleAction(action, nextBody, config)).ok, true);
      assert.equal(calls.length, before + 2);
      assert.deepEqual(calls.at(-1), { action, body: nextBody }, 'Core must still receive the latest target identities');
    });
  }
  await t.test('different groups, actions and other payload fields remain distinct', async () => {
    now += 10000;
    const before = calls.length;
    const body = { sessionGroup: 'origin', runId: 'run-a', sessionId: 'session-a', intent: 'scope' };
    for (const [action, input] of [
      ['restart-session', body],
      ['restart-session', { ...body, sessionGroup: null }],
      ['interrupt', body],
      ['restart-session', { ...body, intent: 'different' }],
      ['restart-session', { ...body, options: { runId: 'nested-a' } }],
      ['restart-session', { ...body, options: { runId: 'nested-b' } }],
    ]) assert.equal((await handleAction(action, input, config)).ok, true);
    assert.equal(calls.length, before + 6);
  });
  for (const action of ['switch-mode', 'switch-runtime']) {
    await t.test(`${action} keeps identity fields in its existing de-duplication key`, async () => {
      now += 10000;
      const before = calls.length;
      const first = { sessionGroup: 'origin', runId: 'old', sessionId: 'old-session', intent: action };
      const second = { ...first, runId: 'new', sessionId: 'new-session' };
      assert.equal((await handleAction(action, first, config)).ok, true);
      assert.equal((await handleAction(action, second, config)).ok, true);
      assert.equal((await handleAction(action, second, config)).error, 'duplicate_request');
      assert.equal(calls.length, before + 2);
    });
  }
});

// Integration boundary: real Core action adapter/formatter and locale dictionaries.
// Run for Core response mapping, validation or translation-key changes; skip
// unrelated collectors/UI. The caller isolates HOME/ZYLOS_DIR/PM2_HOME and short
// TMPDIR. Core socket, commands, timers and spawn are mocked at their I/O boundary;
// no live process, socket, database, runtime, PM2 or network resource is touched.
test('every Core action return path has a bilingual message key', async t => {
  let mode = 'multi';
  let reply = { kind: 'accepted', reply: { ok: true, result: 'accepted' } };
  let lookup = 'unknown';
  const submits = [], commandCalls = [], spawns = [], schedules = [];
  let commands = [];
  const execFile = () => assert.fail('only the promisified command boundary is used');
  execFile[promisify.custom] = async (file, args) => {
    commandCalls.push({ file, args });
    assert.ok(commands.length, `unexpected command ${file}`);
    const value = commands.shift();
    if (value instanceof Error) throw value;
    return { stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' };
  };
  t.mock.module('node:child_process', { namedExports: { ...childProcess, execFile, spawn: (file, args) => {
    spawns.push({ file, args }); const child = new EventEmitter(); child.unref = () => {}; return child;
  } } });
  t.mock.module('node:timers/promises', { namedExports: { ...timerPromises, setTimeout: async milliseconds => { assert.equal(milliseconds, 500); } } });
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds) => { schedules.push({ callback, milliseconds }); return { unref() {} }; });
  t.mock.module('../src/lib/core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'config.js') return { readSessionMode: () => ({ mode }) };
    if (name === 'am-sock-client.js') return {
      submit: async request => { submits.push(structuredClone(request)); return structuredClone(reply); },
      lookupRestartRequest: async () => { if (lookup instanceof Error) throw lookup; return lookup; },
    };
    assert.fail(`unexpected Core module ${name}`);
  } } });
  const { handleCoreAction } = await import('../src/lib/core-actions.js?bilingual-feedback');
  const config = { zylosDir: process.env.ZYLOS_DIR };
  const body = () => ({ sessionGroup: mode === 'multi' ? 'origin' : null, runId: 'run-current', sessionId: 'session-current' });
  const invoke = async (action, input, expected) => localized(await handleCoreAction(action, input, config), expected);

  for (const currentMode of ['single', 'multi']) {
    mode = currentMode;
    await t.test(`${mode} restart acceptance, rejection and transport results`, async () => {
      for (const result of ['accepted', 'already_accepted', 'already_stopped']) {
        reply = { kind: 'accepted', reply: { ok: true, result } };
        const expected = result === 'already_stopped' && mode === 'multi' ? 'result.restart_wake_requested' : `result.restart_${result}`;
        const response = await invoke('restart-session', body(), expected);
        assert.equal(response.ok, true);
        assert.equal(response.result, result);
        assert.equal(submits.at(-1).expectedRunId, 'run-current');
        assert.equal(submits.at(-1).expectedSessionId, 'session-current');
      }
      for (const reason of ['target_required', 'transition_open', 'restart_all_pending', 'fence_conflict', 'manual_restart_pending', 'identity_unavailable', 'not_ready', 'requests_unreadable', 'request_conflict', 'wake_failed']) {
        reply = { kind: 'rejected', reply: { ok: false, result: 'rejected', reason } };
        const expected = mode === 'multi' && reason === 'wake_failed' ? 'result.restart_wake_failed' : 'result.restart_rejected';
        const response = await invoke('restart-session', body(), expected);
        assert.equal(response.ok, false);
        assert.equal(response.reason, reason);
        if (expected === 'result.restart_rejected') assert.equal(response.messageParams.code, reason);
      }
      reply = { kind: 'rejected', reply: { ok: false, result: 'stale_target', currentRunId: 'replacement-run' } };
      assert.equal((await invoke('restart-session', body(), 'result.restart_target_changed')).messageParams.runId, 'replacement-run');
      for (const transport of [
        { kind: 'connect_failed', sent: false },
        { kind: 'deadline_exceeded', sent: false },
        { kind: 'deadline_exceeded', sent: true },
        { kind: 'invalid_reply', sent: true },
      ]) {
        reply = transport;
        const notSubmitted = transport.kind === 'connect_failed' || !transport.sent;
        const response = await invoke('restart-session', body(), notSubmitted ? 'result.restart_not_submitted' : 'result.restart_unknown');
        assert.equal(response.submission, notSubmitted ? 'not_submitted' : 'unknown');
      }
      reply = { kind: 'deadline_exceeded', sent: true };
      for (const completion of ['done', 'deadline_exceeded', new Error('lookup unavailable')]) {
        lookup = completion;
        const response = await invoke('restart-session', body(), 'result.restart_unknown');
        assert.equal(response.completion, completion === 'done' ? 'done' : 'unknown');
      }
      lookup = 'unknown';
    });

    await t.test(`${mode} control and target validation results`, async () => {
      for (const action of ['interrupt', 'chop-chop']) {
        const missing = await invoke(action, { sessionGroup: body().sessionGroup }, 'result.target_required');
        assert.equal(missing.error, 'TARGET_REQUIRED');
        for (const first of [
          { ok: true, data: { id: 11 } },
          { ok: false, error: { code: 'DB_BUSY' } },
          { ok: false, unknown: true, error: { code: 'RESULT_UNKNOWN' } },
          { ok: true, data: {} },
        ]) {
          commands = [first];
          if (action === 'chop-chop' && first.ok && first.data.id) commands.push({ ok: true, data: { id: 12 } });
          const result = await invoke(action, body());
          assert.equal(result.steps.length, action === 'chop-chop' && first.data?.id ? 2 : 1);
          assert.equal(commands.length, 0);
        }
        const mismatch = await invoke(action, { ...body(), sessionGroup: mode === 'multi' ? null : 'origin' }, 'result.target_scope_mismatch');
        assert.equal(mismatch.error, 'TARGET_SCOPE_MISMATCH');
      }
      for (const second of [
        { ok: true, data: { id: 32 } },
        { ok: false, error: { code: 'STALE_TARGET', runId: 'replacement' } },
        { ok: false, unknown: true, error: { code: 'RESULT_UNKNOWN' } },
        { ok: false, error: { code: 'DB_BUSY' } },
      ]) {
        commands = [{ ok: true, data: { id: 31 } }, second];
        const result = await invoke('chop-chop', body());
        assert.equal(result.steps.length, 2);
        assert.equal(commands.length, 0);
      }
    });

    await t.test(`${mode} mode and runtime command results and validation`, async () => {
      const invalidMode = await invoke('switch-mode', { ...body(), mode: 'invalid' }, 'result.invalid_mode');
      assert.equal(invalidMode.error, 'INVALID_MODE');
      const invalidRuntime = await invoke('switch-runtime', { ...body(), runtime: 'invalid' }, 'result.invalid_runtime');
      assert.equal(invalidRuntime.error, 'INVALID_RUNTIME');
      const unknown = await invoke('unknown-action', body(), 'result.unknown_action');
      assert.equal(unknown.error, 'UNKNOWN_ACTION');
      for (const command of [
        { ok: true, data: { result: 'accepted' } },
        { ok: true, data: { result: 'noop' } },
        { ok: true, data: { result: 'unchanged' } },
        { ok: false, error: { code: 'transition_open' } },
        { ok: false, error: { code: 'config_unreadable' } },
        { ok: false, error: { code: 'legacy_session_present' } },
        { ok: false, error: { code: 'manual_restart_pending' } },
        { ok: false, error: { code: 'requests_unreadable' } },
        'not-json',
        Object.assign(new Error('command failed'), { stdout: JSON.stringify({ ok: false, error: { code: 'requests_unreadable' } }) }),
        new Error('command transport unavailable'),
      ]) {
        commands = [command];
        const expected = command instanceof Error || typeof command === 'string'
          ? (command?.stdout ? 'result.mode_switch_rejected' : 'result.mode_switch_unknown')
          : command.ok ? (['noop', 'unchanged'].includes(command.data?.result) ? 'result.mode_switch_unchanged' : 'result.mode_switch_accepted')
          : 'result.mode_switch_rejected';
        await invoke('switch-mode', { ...body(), mode: 'multi' }, expected);
        assert.equal(commandCalls.at(-1).file, 'zylos');
        assert.deepEqual(commandCalls.at(-1).args, ['session-mode', 'switch', 'multi', '--json']);
      }
      for (const command of [
        { ok: true, data: { result: 'saved' } },
        { ok: true, data: { result: 'unchanged' } },
        { ok: false, error: { code: 'AUTH_REQUIRED' } },
        'not-json',
        new Error('runtime command unavailable'),
      ]) {
        commands = [command];
        const response = await invoke('switch-runtime', { ...body(), runtime: 'codex' });
        assert.equal(response.messageKey, command?.data?.result === 'saved' ? 'result.runtime_saved' : command?.data?.result === 'unchanged' ? 'result.runtime_unchanged' : 'result.runtime_unknown');
      }
    });
  }
  assert.equal(schedules.length, 2, 'only saved runtime results schedule Dashboard restart');
  for (const timer of schedules) { assert.equal(timer.milliseconds, 1000); timer.callback(); }
  assert.deepEqual(spawns, Array.from({ length: 2 }, () => ({ file: 'pm2', args: ['restart', 'zylos-dashboard'] })));
});

test('English and Chinese translation keys are complete and identical', () => {
  const en = dictionary('en'), zh = dictionary('zh');
  const keys = Object.keys(en);
  assert.equal(keys.length, Object.keys(zh).length);
  for (const key of keys) {
    assert.ok(Object.hasOwn(zh, key), `Chinese missing ${key}`);
    assert.equal(typeof en[key], 'string');
    assert.equal(typeof zh[key], 'string');
    assert.ok(en[key].length > 0 && zh[key].length > 0, `empty locale entry ${key}`);
  }
});
