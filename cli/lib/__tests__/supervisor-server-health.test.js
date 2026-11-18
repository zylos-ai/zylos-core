import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorServerHealth, DEFAULT_ALERT_DESTINATION, parseServerAlertTarget } from '../supervisor-server-health.js';

test('a configured Origin failure never sends to Origin twice', async () => {
  for (const throws of [false, true]) {
    const calls = [];
    const result = await new SupervisorServerHealth({
      readAlertTarget: () => parseServerAlertTarget('dashboard:origin'),
      sendAlert: async target => {
        calls.push(target);
        if (throws) throw Error('Origin unavailable');
        return false;
      },
    }).notify('scheduler failure');
    assert.equal(result, false);
    assert.deepEqual(calls, [DEFAULT_ALERT_DESTINATION]);
  }
});


test('notify returns success for any non-false configured or fallback result and false for fallback failures', async () => {
  const owner = { channel: 'feishu', endpoint: 'owner' };
  for (const configured of [null, owner]) {
    for (const outcome of [undefined, null, 0, '', true, false, 'throw']) {
      const calls = [];
      const result = await new SupervisorServerHealth({
        readAlertTarget: () => configured,
        sendAlert: async target => {
          calls.push(target);
          if (target === owner) return false;
          if (outcome === 'throw') throw Error('Origin unavailable');
          return outcome;
        },
      }).notify('scheduler failure');
      assert.equal(result, outcome !== false && outcome !== 'throw');
      assert.deepEqual(calls, configured ? [owner, DEFAULT_ALERT_DESTINATION] : [DEFAULT_ALERT_DESTINATION]);
    }
  }
  for (const outcome of [undefined, null, 0, '', true]) {
    const calls = [];
    const result = await new SupervisorServerHealth({
      readAlertTarget: () => owner,
      sendAlert: async target => { calls.push(target); return outcome; },
    }).notify('scheduler failure');
    assert.equal(result, true);
    assert.deepEqual(calls, [owner]);
  }
});
