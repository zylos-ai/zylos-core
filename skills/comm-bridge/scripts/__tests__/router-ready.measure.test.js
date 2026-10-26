import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv, runMeasurements } from './router-ready.measure.js';

test('P04 real-runtime READY measurement (explicit opt-in)', { skip: process.env.READY_MEASURE !== '1' }, async t => {
  const result = await runMeasurements(configFromEnv());
  t.diagnostic(JSON.stringify({ status: result.summary.status, sampleCount: result.summary.sampleCount, evidence: result.runDir }));
  assert.equal(result.ok, true, result.summary.error || 'See structured evidence for failed samples');
});
