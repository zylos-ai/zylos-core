import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_MODULE && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
// Boundary: real Content/question/chart renderers plus shipped CSS in Chrome;
// no Dashboard backend, database, tmux, PM2 or model is opened. Run after rich
// component presentation/styles change; unrelated backend/runtime work may skip.
// The opt-in sandbox proves HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket
// and both unused DB paths before opening fixture HTTP and spawning the lifecycle-owned Chrome group.
// Timeout, abort and failure reap Chrome, fixture HTTP, contexts and the private root.
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`rich components preserve answer order and static status in ${theme} at ${width}`, {
    skip: !enabled, timeout: 45_000,
  }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      sandbox.assertIsolation();
      const { runComponentAppearanceBrowser } = await import('./helpers/chat-component-appearance-browser.js');
      await runComponentAppearanceBrowser(sandbox, { width, theme });
    }, { timeoutMs: 40_000 });
  });
}
