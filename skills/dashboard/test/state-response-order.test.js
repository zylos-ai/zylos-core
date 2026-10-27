import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const refresh = app.slice(app.indexOf('async function refreshState()'), app.indexOf('async function refreshMetrics()'));
function harness() {
  const pending = [];
  const state = { navigationGeneration: 0, dashboardState: { runId: 'R1', sessionId: 'S1' } };
  const context = vm.createContext({ state, fetchJson: () => new Promise(resolve => pending.push(resolve)), applyRuntimeVisibility() {}, renderInfoBar() {}, renderState() {}, renderHealth() {} });
  vm.runInContext(refresh, context);
  return { state, pending, refresh: context.refreshState };
}
test('a response predating a newer SSE observation cannot restore an old run', async () => {
  const h = harness(); const request = h.refresh();
  h.state.stateRevision = 1; h.state.dashboardState = { runId: 'R2', sessionId: 'S2' };
  h.pending[0]({ runId: 'R1', sessionId: 'S1' }); await request;
  assert.equal(h.state.dashboardState.runId, 'R2');
  const current = h.refresh(); h.pending[1]({ runId: 'R2', sessionId: 'S2', state: 'BUSY' }); await current;
  assert.equal(h.state.dashboardState.state, 'BUSY');
});
test('overlapping HTTP responses retain the most recently requested state', async () => {
  const h = harness(); const first = h.refresh(); const second = h.refresh();
  h.pending[1]({ runId: 'R2' }); await second;
  h.pending[0]({ runId: 'R1' }); await first;
  assert.equal(h.state.dashboardState.runId, 'R2');
});
test('a response from the previous fleet target cannot overwrite the current target', async () => {
  const h = harness(); const first = h.refresh(); h.state.navigationGeneration++;
  h.state.dashboardState = { runId: 'REMOTE' }; h.pending[0]({ runId: 'LOCAL' }); await first;
  assert.equal(h.state.dashboardState.runId, 'REMOTE');
});
