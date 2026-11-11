import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: the real Dashboard page in a local browser viewing a remote machine through fixed fleet answers; the
// remote's state allows remote access, then its conversation or observer requests are refused with
// remote_chat_disabled. No Core, runtime, PM2, tmux or database is started.
// Run for changes to how a remote view handles the remote access switch (app.js wiring of the refusal, the
// conversation page's refusal, the observer's request errors, public/js/wb/remote-access.js); skip for backend-only
// changes and pages that do not touch remote viewing. Opt-in with the same gate as the chat browser cases before any
// directory, server or browser is allocated; the harness proves the private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket
// paths and closes the browser and HTTP server when the case ends.
test('a remote view leaves conversations and the terminal when the remote refuses them mid-browse',
  { skip: !chatEnabled(), timeout: 120_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runRemoteAccessBrowser } = await import('./helpers/remote-access-browser.js');
      await runRemoteAccessBrowser(t, sandbox);
    }, { timeoutMs: 110_000 });
  });
