import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

const cases = [
  // Impact: a forever-pending groups read must abort after the real thirty-second
  // budget, report failure and let the next poll recover. Run for board request
  // deadlines/coalescing/error changes; unrelated work may skip.
  { name: 'a hanging board groups request times out and recovers on the next poll at 390px', kind: 'timeout', held: 'groups', locale: 'zh', width: 390 },
  // Impact: persistently unanswered optional cost reads must abort, reveal groups
  // with blank costs and allow later polls without errors or overlapping reads.
  // Run for cost deadlines/optional-data handling; unrelated work may skip.
  { name: 'hanging optional cost requests leave groups visible with blank costs after timeout at 390px', kind: 'timeout', held: 'cost', locale: 'zh', width: 390 },
  // Impact: main-pack delay must not serialize the independent workbench pack or
  // observer startup. Run for i18n/startup coordination changes; other work may skip.
  ...[390, 1280].map(width => ({ name: `fresh Chinese starts independent requests before an eight-second main pack at ${width}px`, kind: 'parallel', locale: 'zh', width })),
  // Impact: every groups response takes seven seconds, including startup reads.
  // Run for board polling, startup deadlines or loading UI; other work may skip.
  ...[390, 1280].flatMap(width => ['zh', 'en'].map(locale => ({ name: `${locale} shows loading then seven-second group results without overlapping board polls at ${width}px`, kind: 'groups', locale, width }))),
  // Impact: initial HTTP failure needs a visible translated state in the board.
  // Run for initial board/error/i18n changes; unrelated changes may skip.
  ...[390, 1280].flatMap(width => ['zh', 'en'].map(locale => ({ name: `${locale} shows a groups HTTP 500 error at ${width}px`, kind: 'error', locale, width }))),
];

let failed = false;
for (const scenario of cases) {
  // Explicit opt-in plus the official Node runner are required. The harness
  // proves HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR, private socket and both DB
  // paths before browser/HTTP startup. No tmux, PM2 or database is opened.
  // Each case owns browser contexts, pending routes, timers, streams and server.
  test(scenario.name, { skip: !chatEnabled(), timeout: scenario.kind === 'timeout' ? 65000 : 45000 }, async t => {
    if (failed) { t.skip('a prior startup case already provided a counterexample'); return; }
    const sandbox = createChatSandbox(t);
    try {
      await sandbox.runCase(async () => {
        const { runStartupParallelBrowser } = await import('./helpers/dashboard-startup-parallel-browser.js');
        await runStartupParallelBrowser(sandbox, scenario);
      }, { timeoutMs: scenario.kind === 'timeout' ? 55000 : 35000 });
    } catch (error) { failed = true; throw error; }
  });
}
