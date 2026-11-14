import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_MODULE && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
// Boundary: shipped parser, diagram renderer and CSS, including container-width
// direction, parallel nodes, groups, literal labels and icon masks. Run after
// diagram or conversation-layout changes; unrelated backend work may skip.
// Before HTTP/Chrome, prove private HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR,
// socket and unused DB paths. No backend/DB/tmux/PM2 is opened; teardown owns
// every HTTP server, browser context and child, including failure/timeout paths.
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`diagram renders bounded flows in ${theme} at ${width}`, { skip: !enabled, timeout: 40_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      sandbox.assertIsolation();
      const { runDiagramBrowser } = await import('./helpers/diagram-browser.js');
      await runDiagramBrowser(sandbox, { width, theme });
    }, { timeoutMs: 35_000 });
  });
}
