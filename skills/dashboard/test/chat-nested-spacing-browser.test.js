import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_MODULE && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
// Boundary: real Content/View renderers and shipped CSS in Chrome cover the
// section stack/columns following boundary and all six nested compositions.
// Run after View spacing or related cascade changes; unrelated backend work may skip.
// The opt-in sandbox proves HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/private socket
// and both unused DB paths before fixture HTTP and lifecycle-owned Chrome start.
// No backend, DB, tmux, PM2 or model is opened. Timeout/failure reaps all resources.
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`nested containers preserve section boundaries and internal spacing in ${theme} at ${width}`, {
    skip: !enabled, timeout: 45_000,
  }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      sandbox.assertIsolation();
      const { runNestedSpacingBrowser } = await import('./helpers/chat-nested-spacing-browser.js');
      await runNestedSpacingBrowser(sandbox, { width, theme });
    }, { timeoutMs: 40_000 });
  });
}
