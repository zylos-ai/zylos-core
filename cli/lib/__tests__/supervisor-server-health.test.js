import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorServerHealth, DEFAULT_ALERT_DESTINATION, parseServerAlertTarget } from '../supervisor-server-health.js';
import { SupervisorServerHealth as activityMonitorHealth, DEFAULT_ALERT_DESTINATION as activityMonitorDefault } from '../../../skills/activity-monitor/scripts/supervisor-server-health.js';
import { parseServerAlertTarget as activityMonitorParser } from '../../../skills/activity-monitor/scripts/supervisor-server-observation.js';

test('activity-monitor public exports are the same shared alert implementation', () => {
  assert.equal(activityMonitorHealth, SupervisorServerHealth);
  assert.equal(activityMonitorDefault, DEFAULT_ALERT_DESTINATION);
  assert.equal(activityMonitorParser, parseServerAlertTarget);
  assert.ok(Object.isFrozen(DEFAULT_ALERT_DESTINATION));
});

test('shared notify preserves default, invalid, and unreadable target fallback', async () => {
  for (const value of [undefined, 'default', '', 'invalid', ':owner', 'feishu:', 'feishu:owner\n']) {
    const calls = [];
    const health = new SupervisorServerHealth({
      readAlertTarget: () => parseServerAlertTarget(value),
      sendAlert: async (target, message) => calls.push({ target, message }),
    });
    assert.equal(await health.notify('scheduler failure'), true);
    assert.deepEqual(calls, [{ target: { channel: 'dashboard', endpoint: 'origin' }, message: 'scheduler failure' }]);
  }
  const calls = [];
  const result = await new SupervisorServerHealth({
    readAlertTarget: async () => { throw Error('unreadable config'); },
    sendAlert: async target => calls.push(target),
  }).notify('scheduler failure');
  assert.equal(result, true);
  assert.deepEqual(calls, [DEFAULT_ALERT_DESTINATION]);
});

test('shared notify tries a configured owner then Origin once on false or thrown sends', async () => {
  for (const outcome of ['success', 'false', 'throw']) {
    const calls = [], logged = [];
    const owner = parseServerAlertTarget('feishu:owner|type:p2p');
    const result = await new SupervisorServerHealth({
      readAlertTarget: () => owner,
      log: error => logged.push(error.message),
      sendAlert: async (target, message) => {
        calls.push({ target, message });
        if (target === owner) {
          if (outcome === 'throw') throw Error('owner unavailable');
          return outcome !== 'false';
        }
        throw Error('Origin unavailable');
      },
    }).notify('scheduler failure');
    assert.equal(result, outcome === 'success');
    assert.deepEqual(calls, (outcome === 'success' ? [owner] : [owner, DEFAULT_ALERT_DESTINATION])
      .map(target => ({ target, message: 'scheduler failure' })));
    assert.deepEqual(logged, outcome === 'success' ? [] : outcome === 'false'
      ? ['Origin unavailable'] : ['owner unavailable', 'Origin unavailable']);
  }
});

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
