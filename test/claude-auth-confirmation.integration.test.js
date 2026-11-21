import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSupervisor } from '../skills/activity-monitor/scripts/supervisor.js';
import { collectHealthHook } from '../skills/activity-monitor/scripts/hook-health.js';
import { HealthEventReader } from '../skills/activity-monitor/scripts/health-event-reader.js';
import { RestartRequestStore } from '../skills/activity-monitor/scripts/restart-request-store.js';
import { freezeFirstFailureNotice } from '../skills/comm-bridge/scripts/first-failure-notice.js';
import { fixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { groupRunDir } from '../cli/lib/session-group-paths.js';

// Native hook collector -> durable event reader -> assembled health writer -> C4
// notice and routing. Run for hook auth classification or probe wiring changes.
// Skip for unrelated runtime or UI changes. Run through the isolated Node
// runner with private HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR. This fixture
// uses an in-memory C4 database, with no tmux, model CLI or network.
test('Claude StopFailure confirms shared authentication before blocking other sessions', {timeout:5000}, async t=>{
  for (const scenario of ['success', 'failure', 'timeout', 'model access']) await t.test(scenario, async t=>{
    let calls = 0;
    let probe = Promise.resolve({status:scenario, reason:'cli_probe_credentials_rejected'});
    const started = Promise.withResolvers();
    const checkAuth = () => { calls++; started.resolve(); return probe; };
    const {db,store:c4} = fixture(t);
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'claude-auth-'));
    const env = {ZYLOS_DIR:root};
    const groups = ['first','second','healthy'].map(endpoint=>{
      const sessionGroup = `telegram:${endpoint}`;
      db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES ('in','telegram',?,'work','delivered',?)")
        .run(endpoint,sessionGroup);
      return {endpoint, sessionGroup, runDir:groupRunDir(sessionGroup,env), runId:randomUUID(),
        sessionId:randomUUID(), runtime:'claude', present:true, ready:true};
    });
    const supervisor = createSupervisor({db:c4, scenes:{observe:async()=>groups},
      zylosDir:root, env, checkAuth, readMode:()=>({mode:'multi'}),
      readConfiguration:()=>({mode:'multi',runtime:'claude',capacity:3}),
      resolveTargetRuntime:()=> 'claude',
      requestStore:new RestartRequestStore({file:path.join(root,'requests.json')}),
      freezeNotice:input=>freezeFirstFailureNotice(db,input),
    });
    const reader = new HealthEventReader({coordinator:supervisor.health,zylosDir:root,quota:()=>null});
    t.after(async ()=>{
      reader.close();
      await supervisor.stop();
      fs.rmSync(root,{recursive:true,force:true});
    });
    await supervisor.loop.deps.readConfiguration();
    const store = supervisor.health.store('claude');
    const consume = (scene,error_details) => {
      const identity = {runtime:'claude', session_id:scene.sessionId, claude_pid:123};
      collectHealthHook({hook_event_name:'StopFailure',session_id:scene.sessionId,prompt_id:'p',
        error:'authentication_failed',error_details}, {zylosDir:root,pid:123,
        env:{...env,ZYLOS_SESSION_GROUP:scene.sessionGroup,ZYLOS_RUN_ID:scene.runId}});
      return reader.consumeScene(scene, identity);
    };
    const route = () => supervisor.router.route({version:2,type:'route',requestId:'healthy',
      noReply:false,receivedAt:Date.now(),channel:'telegram',endpoint:'healthy',
      componentName:'telegram',sessionGroup:groups[2].sessionGroup});
    const notice = scene=>store.read(scene.sessionGroup).pending_notice;

    if (scenario === 'timeout') {
      const {promise, resolve} = Promise.withResolvers();
      probe = promise;
      const pending = [consume(groups[0]), consume(groups[1])];
      try {
        await started.promise;
        assert.equal((await route()).decision,'pending');
      } finally {
        resolve({status:'uncertain',reason:'cli_probe_uncertain'});
        await Promise.all(pending);
      }
      assert.equal(calls,1);
      assert.equal(notice(groups[1]).notice.noticeCode,'unavailable');
    } else {
      const detail = scenario === 'model access' ? 'Your model policy only allows Sonnet.' : 'API Error: 403 Forbidden';
      await consume(groups[0],detail);
      assert.equal(calls,scenario==='model access' ? 0 : 1);
    }
    const failed = scenario === 'failure';
    assert.equal(store.read().health,failed ? 'auth_failed' : 'ok');
    assert.equal(notice(groups[0]).endpoint,groups[0].endpoint);
    assert.equal(notice(groups[0]).health,failed ? 'auth_failed' : 'unavailable');
    assert.equal(notice(groups[0]).notice.noticeCode,
      failed ? 'auth_failed' : scenario==='model access' ? 'model_unavailable' : 'unavailable');
    assert.equal(store.read(groups[0].sessionGroup).failure_retry,undefined);
    assert.equal(notice(groups[2]),undefined);
    assert.equal((await route()).decision,failed ? 'auth_rejected' : 'pending');
    await supervisor.loop.deps.writeMetricsAndMaintain({scenes:groups,fences:[]});
    assert.equal(supervisor.health.authTargets('claude').length,0);
    assert.equal(c4.listDrainFences().length,0);
    assert.equal(db.prepare('SELECT count(*) FROM control_queue').pluck().get(),0);
    if (failed) {
      probe = Promise.resolve({status:'success'});
      await supervisor.router.notifyAuthCompleted({version:1,type:'auth_completed',requestId:'login',runtime:'claude'});
      assert.equal(supervisor.health.authTargets('claude').length,groups.length);
    }
  });
});
