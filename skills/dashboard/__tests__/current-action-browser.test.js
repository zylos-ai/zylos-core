import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Real shipped board/Fleet DOM with canonical compact projections. No Core,
// runtime, PM2 or database starts; the official sandbox owns every resource.
for (const width of [390, 1280]) for (const locale of ['zh', 'en']) {
  test(`compact current action and no-response observations at ${width}px in ${locale}`, {
    skip: !chatEnabled(), timeout: 30000,
  }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runCurrentActionBrowser } = await import('./helpers/current-action-browser.js');
      await runCurrentActionBrowser(sandbox, { width, locale });
    }, { timeoutMs: 25000 });
  });
}
