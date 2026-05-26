import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statusUtilsSource = fs.readFileSync(path.join(__dirname, '..', 'status-utils.js'), 'utf8');

function loadBrowserStatusUtils() {
  const sandbox = { window: {} };
  vm.runInNewContext(statusUtilsSource, sandbox);
  return sandbox.window.ZylosStatusUtils;
}

function assertDisplay(actual, expected) {
  assert.equal(actual.className, expected.className);
  assert.equal(actual.text, expected.text);
}

describe('browser status display', () => {
  it('prioritizes unhealthy health over idle state', () => {
    const { getStatusDisplay } = loadBrowserStatusUtils();
    assertDisplay(
      getStatusDisplay({ state: 'idle', health: 'unavailable' }),
      { className: 'offline', text: 'Runtime unavailable' }
    );
  });

  it('shows specific status for rate limit and auth failures', () => {
    const { getStatusDisplay } = loadBrowserStatusUtils();
    assertDisplay(
      getStatusDisplay({ state: 'idle', health: 'rate_limited' }),
      { className: 'busy', text: 'Runtime is rate limited' }
    );
    assertDisplay(
      getStatusDisplay({ state: 'busy', health: 'auth_failed' }),
      { className: 'offline', text: 'Runtime auth failed' }
    );
  });

  it('uses runtime wording for healthy busy and idle states', () => {
    const { getStatusDisplay } = loadBrowserStatusUtils();
    assertDisplay(
      getStatusDisplay({ state: 'busy', health: 'ok' }),
      { className: 'busy', text: 'Runtime is busy' }
    );
    assertDisplay(
      getStatusDisplay({ state: 'idle', health: 'ok' }),
      { className: 'online', text: 'Runtime is ready' }
    );
  });
});
