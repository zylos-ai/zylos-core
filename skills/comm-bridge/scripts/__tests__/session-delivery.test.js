import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';

process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
const { main } = await import('../c4-dispatcher.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// this replaces extraction of the retired single-lane loop. Delivery
// semantics are exercised directly in router-delivery{,-tmux,-pure}.test.js.
test('production entry starts one factory and drains before closing DB on repeated signals', async () => {
  const signals = new EventEmitter(), drain = deferred(), events = [];
  const controller = await main({ signals, log() {}, closeDatabase: () => events.push('close'),
    create: () => { events.push('create'); return {
      start: async () => events.push('start'),
      stop: async () => { events.push('stop'); await drain.promise; events.push('drained'); },
    }; } });
  signals.emit('SIGTERM'); signals.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['create','start','stop']);
  drain.resolve(); await controller.shutdown();
  assert.deepEqual(events, ['create','start','stop','drained','close']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});
