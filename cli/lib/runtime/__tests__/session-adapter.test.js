import { getRuntime } from '../index.js';
import { createSessionOps } from '../session-ops.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';


function fixture({present = true, runId = 'r', openError, runtime = 'claude'} = {}) {
  const calls = [], target = {present, runId, runtime, tmuxSessionId:'$7', paneId:'%8'};
  const connection = {cleanupBuffer:async name => calls.push(['delete-buffer','-b',name]), close:() => calls.push(['close']), command:async argv => { calls.push(argv); if (argv[0] === 'kill-session') target.present = false; if (argv[0] === 'display-message') {if(!target.present)throw error('TARGET_GONE');return '$7';} return 'screen'; }};
  const dependencies = {
    openTmuxConnection:async () => { if (openError) throw openError; return connection; },
    observeSessionTarget:async () => target,
    revalidateSessionTarget:async () => { calls.push(['validate']); },
    readTargetRuntime:async () => { throw Error('isRunning must use pane observation'); },
  };
  const options = { dependencies };
  const adapter = createSessionOps(options);
  return {adapter, options, dependencies, target, connection, calls};
}
const error = (code,cause) => Object.assign(new Error(code),{code,cause});


test('absence only: no server is false; timeout remains unavailable',async () => {
  assert.deepEqual(await fixture({openError:error('TMUX_NO_SERVER')}).adapter.isRunning({tmuxName:'x'}),{tmux:false,process:false});
  await assert.rejects(fixture({openError:error('TMUX_UNAVAILABLE','timeout')}).adapter.isRunning({tmuxName:'x'}),{code:'TMUX_UNAVAILABLE',cause:'timeout'});
});
for (const bracketedPaste of [false, true]) test(`multiline text preserves bracketed paste=${bracketedPaste} in one guarded batch`,async () => {
  const f=fixture(); let file;
  f.connection.commandBatch=async commands=> {
    f.calls.push(['batch',commands]);
    assert.deepEqual(commands.map(c=>c[0]),['load-buffer','paste-buffer']);
    const load=commands[0],paste=commands[1];file=load[3];
    assert.equal(paste.includes('-p'), bracketedPaste);
    assert.equal(await fs.readFile(file,'utf8'),'one\ntwo');
    assert.equal((await fs.stat(file)).mode & 0o777,0o600);
    assert.equal(load[2],paste[paste.indexOf('-b')+1]);
  };
  await f.adapter.sendText({ runtime: 'claude', target:f.target,connection:f.connection,text:'one\ntwo',bracketedPaste});
  assert.deepEqual(f.calls.map(c=>c[0]),['validate','batch','delete-buffer']);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('keystroke options and command syntax are rejected before any target I/O',async()=>{
  for(const key of ['-l','-R',';','Enter;run-shell','C-c\n','']){
    const f=fixture();await assert.rejects(f.adapter.sendKeys({target:f.target,connection:f.connection,keys:[key]}));
    assert.deepEqual(f.calls,[]);
  }
  const f=fixture();await f.adapter.sendKeys({target:f.target,connection:f.connection,keys:['Escape','Enter','C-c','M-x','F1']});
  assert.deepEqual(f.calls,[['validate'],['send-keys','-t','%8','Escape','Enter','C-c','M-x','F1']]);
});
test('default interactive argv omits model, effort and memory tools',async()=> {
  for(const runtime of ['claude','codex']) {
    const args=(await getRuntime(runtime)).launch.buildArgs({runtime,mode:'default'},{root:'/isolated root'});
    assert.equal(args.includes('--model'),false);
    assert.equal(args.some(x=>x.includes('model_reasoning_effort')),false);
    assert.doesNotMatch(args.join(' '), /memory-mcp-server/);
  }
});
for (const bypassPermissions of [true, false]) {
  for (const mode of ['default', 'override']) {
    test(`Claude disables interactive tools with bypassPermissions=${bypassPermissions} and ${mode} model`, async () => {
      const config = { runtime: 'claude', mode, ...(mode === 'override' ? { model: 'model name', effort: 'high' } : {}) };
      const args = (await getRuntime('claude')).launch.buildArgs(config, { root: '/isolated root', bypassPermissions });
      assert.deepEqual(args.filter(arg => arg.startsWith('--disallowedTools')),
        ['--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode,Artifact,ReportFindings,Workflow']);
      assert.equal(args.includes('--disallowedTools'), false);
      assert.equal(args.includes('--dangerously-skip-permissions'), bypassPermissions);
      const codexArgs = (await getRuntime('codex')).launch.buildArgs({ ...config, runtime: 'codex' },
        { root: '/isolated root', bypassPermissions });
      assert.equal(codexArgs.some(arg => arg.startsWith('--disallowedTools')), false);
    });
    test(`Codex disables interactive tools with bypassPermissions=${bypassPermissions} and ${mode} model`, async () => {
      const settings = ['tools.experimental_request_user_input.enabled=false', 'features.goals=false', 'features.apps=false'];
      const config = { runtime: 'codex', mode, ...(mode === 'override' ? { model: 'model name', effort: 'high' } : {}) };
      const args = (await getRuntime('codex')).launch.buildArgs(config, { root: '/isolated root', bypassPermissions });
      for (const setting of settings) {
        assert.equal(args.filter(arg => arg === setting).length, 1);
        const index = args.indexOf(setting);
        assert.equal(args[index - 1], '-c');
        assert.ok(index < args.length - 1);
      }
      assert.match(args.at(-1), /System startup trigger/);
      assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), bypassPermissions);
      for (const runtime of ['claude', 'agy']) {
        if (runtime === 'agy' && mode === 'override') continue;
        const otherArgs = (await getRuntime(runtime)).launch.buildArgs({ ...config, runtime }, { root: '/isolated root', bypassPermissions });
        assert.equal(settings.some(setting => otherArgs.includes(setting)), false);
        assert.equal(otherArgs.includes('-c'), false);
      }
    });
  }
}
