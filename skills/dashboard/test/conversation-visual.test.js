import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: the new conversation page, actual chat APIs/private databases and local browser.
// Run for page rendering, incremental reading, scrolling or navigation changes; skip unrelated
// backend/runtime changes. Opt-in before allocating resources; the harness proves private
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB paths and owns browser/HTTP/DB cleanup.
test('conversation page preserves editing and reading while new messages arrive',
  { skip: !chatEnabled(), timeout: 160_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runConversationVisual } = await import('./helpers/conversation-visual.js');
      await runConversationVisual(t, sandbox);
    }, { timeoutMs: 150_000 });
  });
