import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

const enabled = chatEnabled() && !!process.env.ZYLOS_CHAT_BROWSER_MODULE && !!process.env.ZYLOS_CHAT_BROWSER_BIN;
// Boundary: actual conversation/question modules and shipped CSS in Chrome. No
// backend, model, tmux, PM2 or database is opened. The shared appearance harness
// owns the fixture HTTP server, browser process and private environment lifecycle.
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`question large fields and submit remain 36px in ${theme} at ${width}`, { skip: !enabled, timeout: 45_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      sandbox.assertIsolation();
      const { runQuestionHeightBrowser } = await import('./helpers/chat-question-height-browser.js');
      await runQuestionHeightBrowser(sandbox, { width, theme });
    }, { timeoutMs: 40_000 });
  });
}
