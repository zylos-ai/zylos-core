import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

const cases = [
  // Boundary: four fresh loads before the normal 30s state poll. Run for initial
  // timezone/request-order changes; unrelated UI can skip.
  { kind: 'reload', loads: 4 },
  // Boundary: both initial API reads are slow; the first visible timestamp after
  // startup settles, including a tab click, must use the instance timezone.
  // Run for state metadata or startup sequencing changes; otherwise skip.
  { kind: 'slow', loads: 2 },
  // Boundary: real SSE replaces state before both enriched HTTP replies. Run for
  // SSE/state freshness or timezone changes; unrelated UI can skip.
  { kind: 'sse-first', loads: 2 },
];
let failed = false;
for (const scenario of cases) {
  test(`initial timestamps use the instance timezone with ${scenario.kind}`, {
    skip: !chatEnabled(), timeout: 45000,
  }, async t => {
    if (failed) { t.skip('an earlier case already supplied a counterexample'); return; }
    const sandbox = createChatSandbox(t);
    try {
      await sandbox.runCase(async () => {
        const { runInitialTimezoneBrowser } = await import('./helpers/dashboard-initial-timezone-browser.js');
        await runInitialTimezoneBrowser(sandbox, scenario);
      }, { timeoutMs: 35000 });
    } catch (error) { failed = true; throw error; }
  });
}
