import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { validObserverSize } from '../public/js/observer-size.js';
const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
function harness() {
  const sent = [];
  const iframe = { style: {} };
  const observer = { generation: 1, lease: { id: 'lease' }, iframe, channel: { postMessage: data => sent.push(data) } };
  const context = vm.createContext({ validObserverSize, state: { observer }, observer, iframe, messageChannel: { port1: {} },
    generation: 1, targetKey: 'local', lease: { id: 'lease' }, observerSessionCurrent: generation => observer.generation === generation,
    frameReadyResolve() {}, setObserverNotice() {}, t: value => value });
  vm.runInContext(app.slice(app.indexOf('function syncObserverSize('), app.indexOf('function releaseObserverLease(')), context);
  const start = app.indexOf('messageChannel.port1.onmessage =');
  vm.runInContext(app.slice(start, app.indexOf('messageChannel.port1.start();', start)), context);
  return { context, observer, iframe, sent, receive: data => context.messageChannel.port1.onmessage({ data }) };
}
test('parent forwards only validated dimensions and rounds valid pixel metrics', () => {
  const h = harness();
  h.context.syncObserverSize({ cols: 100, rows: 30 });
  for (const size of [{ cols: 19, rows: 30 }, { cols: 100.1, rows: 30 }, { cols: 100, rows: 201 }, { preset: 'wide' }]) h.context.syncObserverSize(size);
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent)), [{ type: 'size', cols: 100, rows: 30 }]);
  h.receive({ type: 'metrics', width: 901.2, height: 542.1 });
  assert.deepEqual(h.iframe.style, { width: 'max(100%, 902px)', height: 'max(100%, 543px)' });
  for (const width of [0, -1, Infinity, NaN, '900', 20001]) h.receive({ type: 'metrics', width, height: 500 });
  for (const height of [0, -1, Infinity, NaN, '500', 20001]) h.receive({ type: 'metrics', width: 900, height });
  assert.deepEqual(h.iframe.style, { width: 'max(100%, 902px)', height: 'max(100%, 543px)' });
});
test('metrics from an old generation, lease, or iframe cannot resize the active frame', () => {
  for (const change of [h => h.observer.generation++, h => h.observer.lease.id = 'replacement', h => h.observer.iframe = { style: {} }]) {
    const h = harness(); change(h);
    h.receive({ type: 'metrics', width: 999, height: 600 });
    assert.deepEqual(h.iframe.style, {});
  }
});
