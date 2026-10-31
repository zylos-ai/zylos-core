import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemCollector } from '../src/lib/collectors/system-collector.js';
import { resolveCpuDisplay } from '../public/js/gauge-utils.js';

function makeStubStore() {
  return {
    insertMetric() {},
    upsertSourceHealth() {}
  };
}

test('SystemCollector — single collect has no cpu_pct', async () => {
  const collector = new SystemCollector(makeStubStore(), { zylosDir: '/tmp', runtime: 'test' });
  await collector.collect();
  const data = collector.getLatestSystemData();
  assert.equal(data.cpu_pct, undefined, 'first collect must not have cpu_pct');
  assert.ok(typeof data.mem_total_bytes === 'number', 'mem_total_bytes must exist');
});

test('SystemCollector — warmup produces cpu_pct', async () => {
  const collector = new SystemCollector(makeStubStore(), { zylosDir: '/tmp', runtime: 'test' });
  await collector.warmup();
  const data = collector.getLatestSystemData();
  assert.ok(typeof data.cpu_pct === 'number', 'warmup must produce cpu_pct');
  assert.ok(Number.isFinite(data.cpu_pct), 'cpu_pct must be finite');
});

test('resolveCpuDisplay — valid value updates lastGood', () => {
  const result = resolveCpuDisplay(42, null);
  assert.equal(result.display, '42%');
  assert.equal(result.lastGood, 42);
});

test('resolveCpuDisplay — undefined keeps lastGood', () => {
  const result = resolveCpuDisplay(undefined, 42);
  assert.equal(result.display, '42%');
  assert.equal(result.lastGood, 42);
});

test('resolveCpuDisplay — NaN keeps lastGood', () => {
  const result = resolveCpuDisplay(NaN, 42);
  assert.equal(result.display, '42%');
  assert.equal(result.lastGood, 42);
});

test('resolveCpuDisplay — no history shows --', () => {
  const result = resolveCpuDisplay(undefined, null);
  assert.equal(result.display, '--');
  assert.equal(result.lastGood, null);
});
