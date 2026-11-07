import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Covers actual chat rendering/pagination and browser remote/single policy.
// Run for chat frontend, CSS, routing or policy changes. Skip without the
// explicit integration gate, before creating any DB, server or browser.
// Isolation: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/test DB paths
// are read back before startup; sandbox teardown reclaims child/browser/HTTP resources.
test('chat browser renders paginated history and authoritative questions in both widths and themes',
  { skip: !chatEnabled(), timeout: 150_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runVisualCase } = await import('./helpers/chat-visual.js');
      await runVisualCase(t, sandbox);
    }, { timeoutMs: 140_000 });
  });
