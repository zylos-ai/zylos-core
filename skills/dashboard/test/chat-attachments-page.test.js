import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: actual Dashboard attachment input (choose/paste/drop), shared user
// and agent media, authorized APIs/private SQLite, restoration and image layout.
// Run for attachment frontend or its page/state adapter changes; skip unrelated
// runtime work. The opt-in harness proves HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR,
// private socket and both database paths before opening resources, and owns
// browser/HTTP/DB cleanup on success, failure and timeout. No model is started.
test('attachment input and shared media remain scoped across reads and navigation',
  { skip: !chatEnabled(), timeout: 240_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runAttachmentVisual } = await import('./helpers/chat-attachments-visual.js');
      await runAttachmentVisual(t, sandbox);
    }, { timeoutMs: 230_000 });
  });
