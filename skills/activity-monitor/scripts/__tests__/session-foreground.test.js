import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { readDeliveryIdentity } from '../../../comm-bridge/scripts/runtime-delivery.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-foreground-test-'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session-foreground hook', () => {
  it('binds managed process and refuses unmanaged or subagent SessionStart', async () => {
    process.env.ZYLOS_DIR = tmpDir;
    const { handleSessionForeground } = await import(`../session-foreground.js?identity=${Date.now()}`);
    const options = { platform:'linux', claudePid: 4242, managedProcess:pid=>pid===4242 };
    const record = handleSessionForeground({ session_id: 'new-session' }, options);
    assert.equal(record.runtime, 'claude');
    assert.equal(record.process_start, undefined);
    assert.equal(handleSessionForeground({ session_id: 'late-session' }, {...options,claudePid:4243}), null);
    assert.equal(handleSessionForeground({ session_id: 'unmanaged-session' }, { ...options, managedProcess:()=>false }), null);
    assert.equal(handleSessionForeground({ session_id: 'child-session',agent_id:'child' }, options), null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, 'activity-monitor/foreground-session.json'), 'utf8')).session_id, 'new-session');
  });
  it('uses managed PID verification on Darwin without requiring process start',async()=>{
    process.env.ZYLOS_DIR=tmpDir;
    const {handleSessionForeground}=await import(`../session-foreground.js?darwin=${Date.now()}`);
    let strongChecks=0;
    const record=handleSessionForeground({session_id:'darwin-session',source:'startup'}, {
      platform:'darwin',claudePid:4242,managedProcess:()=>{strongChecks++;return true;},observedAt:4321,
    });
    assert.equal(record.session_id,'darwin-session');assert.equal(record.claude_pid,4242);
    assert.equal(record.observed_at,4321);assert.equal(record.process_start,undefined);assert.equal(strongChecks,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir,'activity-monitor/foreground-session.json'))).session_id,'darwin-session');
    const proof=readDeliveryIdentity({zylosDir:tmpDir,platform:'darwin',run:()=> '4242'});
    assert.equal(proof.session_id,'darwin-session');assert.equal(proof.claude_pid,4242);
    assert.equal(handleSessionForeground({session_id:'subagent',agent_id:'child'}, {platform:'darwin',claudePid:4242}),null);
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
      claudePid: 4242,
      managedProcess: () => true
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
