import test from 'node:test';
import { runCookieBrowser } from '../../../../test/helpers/web-console-cookie-browser.js';

// Real WC HTTP/WS + Chromium + local TLS Caddy, with private DB/config/cert.
// Run for cookie construction, auth/logout wiring, or forwarded prefix changes;
// unrelated UI changes may skip. Use the official runner with a short TMPDIR,
// isolated HOME/ZYLOS_DIR/PM2_HOME/PATH, and explicit installed tool paths.
// No real PM2, tmux server or channel delivery is started; all children are reaped.
test('browser stores scoped TLS cookies and preserves direct HTTP login', {
  skip: process.env.WC_COOKIE_BROWSER_TEST !== '1', timeout: 60000
}, runCookieBrowser);
