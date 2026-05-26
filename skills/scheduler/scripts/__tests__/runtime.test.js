import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildC4ReceiveArgs,
  isRuntimeReady,
  parseC4ReceiveResult
} from '../runtime.js';

describe('isRuntimeReady', () => {
  it('requires busy or idle state with ok health', () => {
    assert.equal(isRuntimeReady({ state: 'idle', health: 'ok' }), true);
    assert.equal(isRuntimeReady({ state: 'busy', health: 'ok' }), true);
    assert.equal(isRuntimeReady({ state: 'idle', health: 'unavailable' }), false);
    assert.equal(isRuntimeReady({ state: 'busy', health: 'rate_limited' }), false);
    assert.equal(isRuntimeReady({ state: 'offline', health: 'ok' }), false);
    assert.equal(isRuntimeReady(null), false);
  });
});

describe('buildC4ReceiveArgs', () => {
  it('requests JSON output so scheduler can inspect the C4 action', () => {
    const args = buildC4ReceiveArgs('/tmp/c4-receive.js', 'run task', {
      priority: 1,
      replyChannel: 'lark',
      replyEndpoint: 'oc_1|type:p2p',
      requireIdle: true
    });

    assert.deepEqual(args, [
      '/tmp/c4-receive.js',
      '--json',
      '--channel',
      'lark',
      '--endpoint',
      'oc_1|type:p2p',
      '--block-queue-until-idle',
      '--priority',
      '1',
      '--content',
      'run task'
    ]);
  });
});

describe('parseC4ReceiveResult', () => {
  it('accepts only queued actions as successful scheduler dispatch', () => {
    assert.deepEqual(
      parseC4ReceiveResult('{"ok":true,"action":"queued","id":123}'),
      { ok: true, action: 'queued', id: 123 }
    );

    assert.throws(
      () => parseC4ReceiveResult('{"ok":true,"action":"delivered","id":123}'),
      /did not queue message/
    );
    assert.throws(
      () => parseC4ReceiveResult('{"ok":true,"action":"suppressed","id":123}'),
      /did not queue message/
    );
    assert.throws(
      () => parseC4ReceiveResult('{"ok":false,"error":{"code":"HEALTH","message":"unavailable"}}'),
      /c4-receive failed \[HEALTH\]/
    );
  });
});
