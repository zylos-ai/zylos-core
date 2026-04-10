import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-foreground-test-'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session-foreground hook', () => {
  it('writes foreground-session.json from SessionStart input', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    process.env.SESSION_FOREGROUND_DISABLE_MAIN = '1';
    const modulePath = new URL('../session-foreground.js', import.meta.url);
    const { handleSessionForeground } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);

    handleSessionForeground({
      type: 'event',
      event: 'session_start',
      session_id: 'session-123',
      source: 'startup'
    }, {
      observedAt: 1234,
      claudePid: 4242
    });

    const written = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'activity-monitor', 'foreground-session.json'), 'utf8')
    );
    assert.equal(written.session_id, 'session-123');
    assert.equal(written.session_start_source, 'startup');
    assert.equal(written.claude_pid, 4242);
  });

  it('returns null when session_id is missing', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    process.env.SESSION_FOREGROUND_DISABLE_MAIN = '1';
    const modulePath = new URL('../session-foreground.js', import.meta.url);
    const { handleSessionForeground } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);

    const result = handleSessionForeground({ type: 'event' }, {
      observedAt: 5678,
      claudePid: 4242
    });
    assert.equal(result, null);
  });
});
