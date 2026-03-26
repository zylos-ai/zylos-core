import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyUsageProbePane } from '../usage-probe-runner.js';

describe('usage-probe-runner', () => {
  it('classifies parseable usage pane as success', () => {
    const pane = [
      'Current session',
      '15% used',
      'Current week (all models)',
      '63% used'
    ].join('\n');

    const result = classifyUsageProbePane(pane);
    assert.equal(result.ok, true);
    assert.equal(result.usage.session, 15);
    assert.equal(result.usage.weeklyAll, 63);
  });

  it('classifies subscription-only response as unsupported plan', () => {
    const pane = '/usage is only available for subscription plans.';
    const result = classifyUsageProbePane(pane);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported_plan');
  });

  it('classifies unrelated pane as parse_failed', () => {
    const result = classifyUsageProbePane('hello world');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'parse_failed');
  });
});
