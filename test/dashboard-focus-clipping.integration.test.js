import test from 'node:test';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

let failed = false;
// Boundary: a real initial file/Git response rebuilds the list during keyboard
// focus. Rerun for memory list rendering/focus changes; unrelated changes may skip.
// The official runner and sandbox prove private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR,
// tmux socket and database paths; browser, HTTP and pending routes die with the case.
test('memory list retains keyboard focus after the initial file response', {
  skip: !chatEnabled(), timeout: 65000,
}, async t => {
  const sandbox = createChatSandbox(t);
  try {
    await sandbox.runCase(async () => {
      const { runFocusClippingBrowser } = await import('./helpers/dashboard-focus-clipping-browser.js');
      await runFocusClippingBrowser(sandbox, { width: 1280, theme: 'light', memoryRefresh: true });
    }, { timeoutMs: 55000 });
  } catch (error) { failed = true; throw error; }
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  // Boundary: actual Dashboard list/delete, pricing tabs/inputs, memory tree/editor,
  // and phone sleeping/pending status controls. Rerun for their spacing, overflow,
  // sizing or focus CSS changes; unrelated changes may skip this gated browser case.
  // The official runner and sandbox isolate HOME, ZYLOS_DIR, PM2_HOME, short TMPDIR,
  // private tmux socket and DB paths. No live service/config/database is opened.
  test(`keyboard focus remains inside clipping containers at ${width}px in ${theme}`, {
    skip: !chatEnabled(), timeout: 65000,
  }, async t => {
    if (failed) { t.skip('a prior focus case already provided a counterexample'); return; }
    const sandbox = createChatSandbox(t);
    try {
      await sandbox.runCase(async () => {
        const { runFocusClippingBrowser } = await import('./helpers/dashboard-focus-clipping-browser.js');
        await runFocusClippingBrowser(sandbox, { width, theme });
      }, { timeoutMs: 55000 });
    } catch (error) { failed = true; throw error; }
  });
}
