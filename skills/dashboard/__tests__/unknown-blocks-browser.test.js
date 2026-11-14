import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_MODULE && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
// New integration boundary: actual parser/renderer/View and shipped CSS in an
// isolated browser. Run for unknown-block rendering changes; skip unrelated
// backend/runtime work. The sandbox proves private HOME/ZYLOS_DIR/PM2_HOME,
// short TMPDIR/socket and unused test DB paths before opening HTTP/Chrome.
// Teardown owns HTTP, browser contexts/processes and private files on all exits.
for (const width of [1280, 390]) test(`unknown block fallback preserves mixed content at ${width}`, {
  skip: !enabled, timeout: 30_000,
}, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    sandbox.assertIsolation();
    const { runUnknownBlocksBrowser } = await import('./helpers/unknown-blocks-browser.js');
    await runUnknownBlocksBrowser(sandbox, width);
  }, { timeoutMs: 25_000 });
});
