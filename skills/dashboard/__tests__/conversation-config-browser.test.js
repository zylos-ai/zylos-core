import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Run this browser case for conversation configuration layout, save synchronization or
// access changes. Unrelated work can skip it. The harness serves the actual Dashboard
// frontend with fixture API responses on private loopback and owns cleanup.
test('conversation AI configuration is shared with group details on desktop and phones',
  { skip: !chatEnabled(), timeout: 120000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runConversationConfigBrowser } = await import('./helpers/conversation-config-browser.js');
      await runConversationConfigBrowser(t, sandbox);
    }, { timeoutMs: 110000 });
  });
