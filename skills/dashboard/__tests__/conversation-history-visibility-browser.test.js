import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Real Dashboard page, ESM and CSS with authenticated private fixture HTTP/SQLite only.
// Run for earlier-history notice layout, scroll anchoring or quote-location changes; skip unrelated backend/runtime work.
// Official runner and opt-in sandbox prove private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB targets;
// browser/context, delayed fetch, HTTP and DB cleanup are tied to each case on pass/failure/timeout.
for (const width of [1280, 390]) for (const trigger of ['manual', 'quote']) {
  test(`${width}: older-history loading and retry stay inside the stream after ${trigger === 'manual' ? 'scrolling to the top' : 'a quote jump'}`,
    { skip: !chatEnabled(), timeout: 45000 }, async t => {
      const sandbox = createChatSandbox(t);
      await sandbox.runCase(async () => {
        const { runHistoryVisibilityBrowser } = await import('./helpers/history-visibility-browser.js');
        await runHistoryVisibilityBrowser(t, sandbox, { width, trigger });
      }, { timeoutMs: 40000 });
    });
}
