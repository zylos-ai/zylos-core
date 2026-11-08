import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: composed Content, conditional forms, tab drafts and Chart.js in the
// actual Dashboard page, real chat API and private SQLite. Run for these frontend
// changes; skip unrelated runtime/backend work. The opt-in harness proves private
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DB paths before opening resources and
// owns browser/HTTP/DB cleanup on success, failure and timeout. No model is started.
test('conversation composition, conditional drafts and charts survive incremental reads',
  { skip: !chatEnabled(), timeout: 180_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runConversationGenuiVisual } = await import('./helpers/conversation-genui-visual.js');
      await runConversationGenuiVisual(t, sandbox);
    }, { timeoutMs: 170_000 });
  });
