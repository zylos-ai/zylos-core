import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: full Dashboard entry, private SQLite histories, authenticated SSE and browser navigation.
// Covers literal hostile HTML, same-side bubble margins/shape/timestamps and AA colors in all eight views, and
// same-subscription readiness/hint/after-cursor ordering after initial reads settle.
// Run for internal-message query/render/navigation/push changes; skip unrelated runtime changes.
// Opt-in runner and sandbox prove HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DB isolation,
// and own browser, observer, HTTP and database cleanup on failure or timeout.
test('internal relays render and navigate between both histories with live updates',
  { skip: !chatEnabled(), timeout: 120_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runInternalConversationBrowser } = await import('./helpers/conversation-internal-browser.js');
      await runInternalConversationBrowser(t, sandbox);
    }, { timeoutMs: 110_000 });
  });
