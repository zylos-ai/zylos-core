import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLatency } from '../public/js/wb/settings-ui.js';
import { documentFixture } from './fixtures/settings-dom.js';

test('latency chart preserves failed probe gaps and bounds its recent samples', () => {
  const document = documentFixture(), root = document.createElement('div');
  const samples = Array.from({ length: 23 }, (_, i) => ({ at: String(i), ms: i % 2 ? null : i * 10 }));
  const chart = renderLatency(root, samples, { document });
  assert.equal(chart.children.length, 20);
  assert.equal(chart.children[0].dataset.latencyMs, '');
  assert.equal(chart.children[0].style.height, '0');
  assert.equal(chart.children[1].dataset.latencyMs, '40');
  assert.match(chart.children[1].title, /40 ms/);
  assert.equal(chart.children.at(-1).style.height, '30px');
});

test('latency chart keeps an all-failure series empty without numeric zero bars', () => {
  const document = documentFixture(), root = document.createElement('div');
  const chart = renderLatency(root, [{ at: 'now', ms: null }], { document });
  assert.equal(chart.children[0].style.height, '0');
  assert.equal(chart.children[0].dataset.latencyMs, '');
});
