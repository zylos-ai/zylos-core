import test from 'node:test';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Boundary: real Dashboard entry, router, settings modules, locales and styles in a browser; fixed HTTP
// answers record local/Fleet URLs and payloads. This does not establish real .env writes or PM2 restarts.
// Run for timezone settings interactions, target/permission wiring or layout changes; skip backend-only edits.
// Opt-in before allocation; private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DB paths are read back before
// launch. No runtime/PM2/tmux/DB starts. Browser, contexts and loopback HTTP close on failure/timeout too.
test('instance time zone settings save and restart separately on desktop and phone',
  { skip: !chatEnabled(), timeout: 200_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { runTimezoneSettingsBrowser } = await import('./helpers/timezone-settings-browser.js');
      await runTimezoneSettingsBrowser(t, sandbox);
    }, { timeoutMs: 190_000 });
  });
