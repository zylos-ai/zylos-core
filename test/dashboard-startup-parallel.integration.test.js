import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

const cases = [
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
  test(scenario.name, { skip: !chatEnabled(), timeout: 45000 }, async t => {
    if (failed) { t.skip('a prior startup case already provided a counterexample'); return; }
    const sandbox = createChatSandbox(t);
    try {
      await sandbox.runCase(async () => {
        const { runStartupParallelBrowser } = await import('./helpers/dashboard-startup-parallel-browser.js');
        await runStartupParallelBrowser(sandbox, scenario);
      }, { timeoutMs: 35000 });
    } catch (error) { failed = true; throw error; }
  });
}
