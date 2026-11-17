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
    await health.notify('scheduler failure');
    assert.deepEqual(calls, [{ target: { channel: 'dashboard', endpoint: 'origin' }, message: 'scheduler failure' }]);
  }
  const calls = [];
  await new SupervisorServerHealth({
    readAlertTarget: async () => { throw Error('unreadable config'); },
    sendAlert: async target => calls.push(target),
  }).notify('scheduler failure');
  assert.deepEqual(calls, [DEFAULT_ALERT_DESTINATION]);
});

test('shared notify tries a configured owner then Origin once on false or thrown sends', async () => {
  for (const outcome of ['success', 'false', 'throw']) {
    const calls = [], logged = [];
    const owner = parseServerAlertTarget('feishu:owner|type:p2p');
    await new SupervisorServerHealth({
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
    assert.deepEqual(calls, (outcome === 'success' ? [owner] : [owner, DEFAULT_ALERT_DESTINATION])
      .map(target => ({ target, message: 'scheduler failure' })));
    assert.deepEqual(logged, outcome === 'success' ? [] : outcome === 'false'
      ? ['Origin unavailable'] : ['owner unavailable', 'Origin unavailable']);
  }
});

test('a configured Origin failure never sends to Origin twice', async () => {
  for (const throws of [false, true]) {
    const calls = [];
    await new SupervisorServerHealth({
      readAlertTarget: () => parseServerAlertTarget('dashboard:origin'),
      sendAlert: async target => {
        calls.push(target);
        if (throws) throw Error('Origin unavailable');
        return false;
      },
    }).notify('scheduler failure');
    assert.deepEqual(calls, [DEFAULT_ALERT_DESTINATION]);
  }
});
