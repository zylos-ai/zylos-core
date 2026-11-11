import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: mounted Dashboard conversation/detail components, fixed loopback API, browser clock and DOM.
// Run when working-indicator presentation, polling, visibility, send follow-up or direct timeline opening changes.
// Unrelated runtime changes can skip. The official runner and opt-in sandbox prove fresh HOME/ZYLOS_DIR/PM2_HOME,
// short TMPDIR, private tmux socket and test database targets before allocation; no DB/runtime/model/channel starts.
// HTTP, contexts and browser are lifecycle-bound and close on success, failure and timeout.
test('conversation working state stays current and opens the group timeline',
  { skip: !chatEnabled(), timeout: 240000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runConversationWorkingBrowser } = await import('./helpers/conversation-working-browser.js');
      await runConversationWorkingBrowser(t, sandbox);
    }, { timeoutMs: 230000 });
  });
