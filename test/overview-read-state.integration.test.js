import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

let failed = false;
for (const width of [390, 1280]) for (const locale of ['zh', 'en']) for (const theme of ['light', 'dark']) {
  for (const kind of ['initial-error', 'refresh-error', 'empty']) {
    // Covers actual app startup, board polling and attention rendering with loopback
    // API fixtures. Run for overview error/empty-state changes; unrelated work may
    // skip. The gated runner and sandbox prove private HOME/ZYLOS_DIR/PM2_HOME,
    // short TMPDIR, socket and DB paths; no tmux, PM2 or database is opened.
    // The sandbox closes browser, SSE connections and HTTP server even on failure.
    test(`${locale} ${theme} overview ${kind} at ${width}px`, { skip: !chatEnabled(), timeout: 25000 }, async t => {
      if (failed) { t.skip('a prior case already supplied a counterexample'); return; }
      const sandbox = createChatSandbox(t);
      try {
        await sandbox.runCase(async () => {
          const { runOverviewReadState } = await import('./helpers/overview-read-state-browser.js');
          await runOverviewReadState(sandbox, { width, locale, theme, kind });
        }, { timeoutMs: 20000 });
      } catch (error) { failed = true; throw error; }
    });
  }
}
