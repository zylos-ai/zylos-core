import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { createRuntimeGeneration, runtimeGenerationEnv } from '../runtime-generation.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-foreground-test-'));
beforeEach(() => fs.rmSync(path.join(tmpDir, 'activity-monitor/runtime-generation.json'), { force: true }));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session-foreground hook', () => {
  it('binds inherited generation and refuses late SessionStart from a superseded launch', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { handleSessionForeground } = await import(`../session-foreground.js?generation=${Date.now()}`);
    const identity = createRuntimeGeneration('claude', { zylosDir: tmpDir });
    const options = { claudePid: 4242, processStart: 'boot:123', env: runtimeGenerationEnv(identity) };
    const record = handleSessionForeground({ session_id: 'new-session' }, options);
    assert.equal(record.runtime_generation, identity.runtime_generation);
    assert.equal(record.process_start, 'boot:123');
    createRuntimeGeneration('codex', { zylosDir: tmpDir });
    assert.equal(handleSessionForeground({ session_id: 'late-session' }, options), null);
    assert.equal(handleSessionForeground({ session_id: 'unmanaged-session' }, { ...options, env: {} }), null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, 'activity-monitor/foreground-session.json'), 'utf8')).session_id, 'new-session');
  });
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
