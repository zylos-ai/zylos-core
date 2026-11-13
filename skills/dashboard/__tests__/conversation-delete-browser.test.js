import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Real full entry/styles/locales with fixed API responses; not live Core deletion or model delivery.
// Run for deletion UI/permission wiring/cache, list row hover/focus/swipe or conversation menu changes; skip backend-only changes.
// Opt-in before allocation; HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket/DB paths are read back.
// No PM2/tmux/DB/model starts. Browser, contexts and loopback HTTP are owned by the sandbox on failure too.
test('conversation deletion reveals by hover, focus or swipe, confirms targets and retains safe retries on desktop and phone',
  { skip: !chatEnabled(), timeout: 200000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runConversationDeleteBrowser } = await import('./helpers/conversation-delete-browser.js');
      await runConversationDeleteBrowser(t, sandbox);
    }, { timeoutMs: 190000 });
  });
