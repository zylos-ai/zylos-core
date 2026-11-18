import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readyTmuxTarget } from './helpers/ready-tmux-target.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';
import { startSupervisor } from '../skills/activity-monitor/scripts/supervisor-main.js';

const enabled = process.env.ZYLOS_SINGLE_SUPERVISOR_INTEGRATION === '1';
// Boundary: actual Supervisor entry, private socket, SQLite, runtime target
// reader and first-failure notice freezing. The launch-config resolver records
// its input; Origin override resolution inside storage is a separate contract.
// Run for entry mode/scope changes. Default skip for unrelated changes.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR. The fixture
// strips ZYLOS_* before starting private tmux and reads its global environment.
// Stop the service and its socket before fixture-owned process/file cleanup.
for (const legacy of [false, true]) test(`single Supervisor entry uses ${legacy ? 'legacy global' : 'Origin'} runtime and notice scope`,
  { skip: !enabled, timeout: 15000 }, async t => {
    const f = readyTmuxTarget(t, {prefix:'single-entry-',mode:'single'});
    f.tmux('new-session','-d','-s','fixture-keeper','sleep','120');
    f.tmux('kill-session','-t','=zylos-group-origin');
    const config = {runtime:'claude',...(legacy ? {} : {session_mode:'single'})};
    const db = createStore(f.db, {readConfig:()=>({state:'ok',config})});
    const selected = [];
    const database = {...db,getDb:()=>f.db,resolveSessionLaunchConfig:input=>{
      selected.push(input); return {runtime:input.sessionGroup === null ? 'claude' : 'codex',mode:'default'};
    }};
    const scenes = {connectionOptions:{socketPath:f.socketPath,binary:f.binary},
      observe:async()=>[],readIdentity:async()=>({present:false}),observeGroup:async()=>({present:false}),
      listRuns:async()=>[],readRun:async()=>null};
    let service;
    try {
      for (const key of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR']) assert.ok(process.env[key]);
      t.diagnostic(JSON.stringify({root:f.root,socket:f.socketPath,legacy,
        HOME:f.env.HOME,ZYLOS_DIR:f.env.ZYLOS_DIR,PM2_HOME:process.env.PM2_HOME,TMPDIR:process.env.TMPDIR}));
      service = await startSupervisor({env:f.env,db:database,scenes,
        readMode:()=>legacy ? {mode:null,keyPresent:false} : {mode:'single',keyPresent:true},readConfig:()=>config,
        legacyPresent:async()=>true,legacyStatus:{tick(){},close(){}},machineTasks:{tick(){},stop(){}},
        log:()=>{},loopOptions:{schedule:()=>1,cancel(){}}});
      selected.length = 0;
      assert.equal(await service.supervisor.router.resolveTargetRuntime('origin'),legacy?'claude':'codex');
      assert.equal(selected.length,1);
      assert.equal(selected[0].sessionGroup,legacy?null:'origin');
      assert.equal(selected[0].sessionMode,legacy?'single':'multi');
      const insert = f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES('in','fake',?,'request','delivered',?)");
      insert.run('origin-room','origin'); insert.run('other-room','fake:other');
      const frozen = service.supervisor.health.freezeNotice({runtime:'claude',sessionGroup:'origin',
        identity:{session_id:'session',claude_pid:123},event:{event:'stop_failure',event_id:'failure',error:'rate_limit',received_at:1000},
        result:{status:'processed',notice:{eligible:true}}});
      assert.equal(frozen instanceof Promise,false,'health notice freezing must remain synchronous');
      assert.equal(frozen.session_group,legacy?null:'origin');
      assert.equal(frozen.endpoint,legacy?'other-room':'origin-room');
      assert.equal(service.supervisor.health.freezeNotice({event:{event:'other'},result:{}}),null);
    } finally { await service?.stop(); }
    const socket = path.join(f.root,'activity-monitor','am.sock');
    assert.equal((await import('node:fs')).existsSync(socket),false);
  });
