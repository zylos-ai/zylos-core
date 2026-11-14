import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: the mounted Dashboard conversation page and header against a fixed loopback API, a paused browser clock
// and the DOM, at 1280 and 390 wide in light and dark. Run when the live activity area's presentation, placement,
// subtask rows or polling, or the conversation header's working caption, changes; the activity reading itself is
// covered by the chat activity unit tests and the cold-start browser case. Unrelated runtime changes can skip. The
// official runner and opt-in sandbox prove fresh HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR, private tmux socket and test
// database targets before allocation; no DB/runtime/model/channel starts. HTTP, contexts and browser are
// lifecycle-bound and close on success, failure and timeout.
test('the conversation page walks through what the AI is doing now, scene by scene',
  { skip: !chatEnabled(), timeout: 240000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runConversationLiveBrowser } = await import('./helpers/conversation-live-browser.js');
      await runConversationLiveBrowser(t, sandbox);
    }, { timeoutMs: 230000 });
  });
