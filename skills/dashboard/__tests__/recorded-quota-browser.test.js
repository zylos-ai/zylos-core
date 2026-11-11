import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Integration: real account reader, retained statusline files, group snapshot,
// full Dashboard page and renderers. Run for quota sources/provenance/layout;
// skip unrelated changes. Gated private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR,
// socket and DB paths are read back before startup. No DB/PM2/tmux is opened;
// live identity/list providers are injected. Loopback/browser/profile teardown
// is bound to success, failure and timeout; external browser requests are denied.
test('reclaimed session quotas render recorded time across Dashboard sizes and themes',
  { skip: !chatEnabled(), timeout: 120000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runRecordedQuotaBrowser } = await import('./helpers/recorded-quota-browser.js');
      await runRecordedQuotaBrowser(sandbox);
    }, { timeoutMs: 110000 });
  });
