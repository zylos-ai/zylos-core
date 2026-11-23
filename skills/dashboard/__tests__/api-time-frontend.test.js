import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { instantMs, instantSeconds, scheduleTimes } from '../public/js/wb/api-time.js';

const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});

const iso = '2026-11-16T09:00:00.000+08:00', ms = Date.parse(iso), seconds = ms / 1000;

test('ISO offset instants parse without converting durations or opaque schedule cursors', () => {
  assert.equal(instantMs(iso), ms); assert.equal(instantSeconds(iso), seconds);
  assert.ok(Number.isNaN(instantMs('not a timestamp')));
  const wire = { readAt: iso, items: [{ nextRunAt: iso, recent: [{ executedAt: iso, completedAt: iso, duration: 1200 }],
    nextRuns: { runs: [iso], in24h: [iso] } }], runs: [iso], nextCursor: 'opaque.cursor' };
  const data = scheduleTimes(wire);
  assert.equal(data.readAt, ms); assert.equal(data.items[0].nextRunAt, seconds);
  assert.equal(data.items[0].recent[0].duration, 1200); assert.equal(data.items[0].recent[0].executedAt, seconds);
  assert.deepEqual(data.items[0].nextRuns, { runs: [seconds], in24h: [seconds] });
  assert.equal(data.nextCursor, wire.nextCursor); assert.deepEqual(data.runs, [seconds]);
  assert.equal(wire.items[0].nextRunAt, iso);
  // A task's history page: execution rows under the same `items`.
  const history = scheduleTimes({ items: [{ executedAt: iso, completedAt: iso, duration: 1200 }], nextCursor: null });
  assert.deepEqual(history.items[0], { executedAt: seconds, completedAt: seconds, duration: 1200 });
});
