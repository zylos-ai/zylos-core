import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: full Dashboard entry and real frontend against private SQLite histories, authenticated SSE and a
// private headless browser. The server's quote step (send `quote` → stored `[quote c4_id=N]` first line, history
// `quote` field) is emulated in front of the real routes until the server side ships.
// Covers: hover/trackpad/touch quoting and its no-trigger cases, the quote bar, history quote blocks (jump with
// older-page loading, unavailable original), annotations (selection, editor, list, preview equals sent content),
// draft survival across reload and conversation switch, and layout at 1280/390 in light and dark.
// Run for changes to the conversation page, composer, quote/annotation modules or their styles; skip otherwise.
// Opt-in runner and sandbox prove HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DB isolation,
// and own browser, observer, HTTP and database cleanup on failure or timeout.
test('messages are quoted and annotated from the conversation page and the draft survives a reload',
  { skip: !chatEnabled(), timeout: 150_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runQuoteAnnotateBrowser } = await import('./helpers/chat-quote-browser.js');
      await runQuoteAnnotateBrowser(t, sandbox);
    }, { timeoutMs: 140_000 });
  });
