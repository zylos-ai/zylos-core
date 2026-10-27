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
  it('binds managed process and refuses unmanaged or subagent SessionStart', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { handleSessionForeground } = await import(`../session-foreground.js?identity=${Date.now()}`);
    const options = { env: { ZYLOS_DIR: tmpDir }, scopeReader: async () => ({ kind: 'legacy' }),
      identityReader: async () => ({ runtime: 'claude', runtimePid: 4242 }) };
    const record = await handleSessionForeground({ session_id: 'new-session' }, options);
    assert.equal(record.runtime, 'claude');
    assert.equal(record.process_start, undefined);
    await assert.rejects(handleSessionForeground({ session_id: 'unmanaged-session' }, { ...options,
      identityReader: async () => { throw Error('unmanaged'); } }), /unmanaged/);
    assert.equal(await handleSessionForeground({ session_id: 'child-session', agent_id: 'child' }, options), null);
    assert.equal(await handleSessionForeground({ session_id: 'child-session', agent_type: 'child' }, options), null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, 'activity-monitor/foreground-session.json'), 'utf8')).session_id, 'new-session');
  });
  it('records the observed Codex runtime without a Claude default',async()=>{
    process.env.ZYLOS_DIR=tmpDir;
    const {handleSessionForeground}=await import(`../session-foreground.js?darwin=${Date.now()}`);
    let strongChecks=0;
    const record=await handleSessionForeground({session_id:'darwin-session',source:'startup'}, {
      env: { ZYLOS_DIR: tmpDir }, scopeReader: async () => ({ kind: 'legacy' }),
      identityReader: async () => { strongChecks++; return { runtime: 'codex', runtimePid: 4242 }; }, observedAt:4321,
    });
    assert.equal(record.session_id,'darwin-session');assert.equal(record.claude_pid,4242);
    assert.equal(record.observed_at,4321);assert.equal(record.process_start,undefined);assert.equal(strongChecks,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir,'activity-monitor/foreground-session.json'))).session_id,'darwin-session');
    assert.equal(record.runtime, 'codex');
    assert.equal(await handleSessionForeground({session_id:'subagent',agent_id:'child'}),null);
  });
  it('writes foreground-session.json from SessionStart input', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    process.env.SESSION_FOREGROUND_DISABLE_MAIN = '1';
    const modulePath = new URL('../session-foreground.js', import.meta.url);
    const { handleSessionForeground } = await import(`${modulePath.href}?t=${Date.now()}-${Math.random()}`);

    await handleSessionForeground({
      type: 'event',
      event: 'session_start',
      session_id: 'session-123',
      source: 'startup'
    }, {
      observedAt: 1234,
      env: { ZYLOS_DIR: tmpDir }, scopeReader: async () => ({ kind: 'legacy' }),
      identityReader: async () => ({ runtime: 'claude', runtimePid: 4242 })
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

    const result = await handleSessionForeground({ type: 'event' }, {
      observedAt: 5678,
      claudePid: 4242
    });
    assert.equal(result, null);
  });
});
