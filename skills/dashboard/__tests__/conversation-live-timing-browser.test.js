import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: the mounted Dashboard conversation page against a loopback API whose group list and activity read answer
// one reading that the test changes, with a paused browser clock moved in two-second steps (no real waiting). It
// proves the page's read pace after a send or a new message, that the header follows the activity read (sender and
// watching tabs, a cold start on a phone), the handled line with no blank, and mark rows. Run when the conversation
// page's polling, its header reading, or the live area's presentation changes; what the server reads is covered by
// the chat activity and working unit tests. Unrelated runtime changes can skip. The official runner and opt-in sandbox
// prove fresh HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR, private tmux socket and test database targets before allocation;
// no DB/runtime/model/channel starts. HTTP, contexts and browser are lifecycle-bound and close on success, failure and
// timeout.
test('the conversation page reads its live work at the pace of the work, and its header follows the same read',
  { skip: !chatEnabled(), timeout: 240000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runConversationLiveTimingBrowser } = await import('./helpers/conversation-live-timing-browser.js');
      await runConversationLiveTimingBrowser(t, sandbox);
    }, { timeoutMs: 230000 });
  });
