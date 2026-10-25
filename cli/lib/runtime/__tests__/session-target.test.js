import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const { openTmuxConnection, serverGeneration } = await import('../tmux-connection.js');
const { observeSessionTarget, resolveSessionTarget, revalidateSessionTarget, readTargetRuntime } = await import('../session-target.js');
const binary = process.env.TEST_TMUX_BIN || 'tmux';
const ready = async () => ({ runId: 'r1', sessionId: 's1', ts: 1, startupControlIds: [] });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p02-target-'));
  const socketPath = path.join(dir, 'tmux.sock');
  const tmux = (...args) => execFileSync(binary, ['-S', socketPath, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-e', 'ZYLOS_RUN_ID=r1', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', 'sleep', '120');
  const connection = await openTmuxConnection({ binary, socketPath, sessionName: 'fixture' });
  t.after(async () => { connection.close(); try { tmux('kill-server'); } catch {} await fs.rm(dir, { recursive: true, force: true }); });
  return { connection, tmux, socketPath, dir, options: { connection, tmuxName: 'fixture', readReady: ready } };
}
test('ordinary commands preserve quoting and leave no retained tmux clients', async t => {
  const {connection, tmux,options,dir} = await fixture(t);
  await resolveSessionTarget(options);
  const values = ["a'b", 'semi;colon', '$HOME', 'a$b', '${HOME}', '$0', '~x', '{a}', '%1', 'a"b', '\\x', 'a\\$b', "quote'and$HOME;tail", '中文$NAME'];
  // tmux 3.4 adds display-only backslashes before named dollars even for
  // unguarded display-message. Verify the action's actual argument bytes instead.
  const received = await Promise.all(values.map(async (value, index) => {
    const buffer = `quoting-${index}`, file = path.join(dir, `bytes-${index}`);
    await connection.commandBatch([
      ['set-buffer', '-b', buffer, value],
      ['save-buffer', '-b', buffer, file],
      ['delete-buffer', '-b', buffer],
    ]);
    return fs.readFile(file, 'utf8');
  }));
  assert.deepEqual(received, values);
  assert.match(await serverGeneration(connection), /^\d+:\d+$/);
  assert.equal(tmux('list-clients','-F','#{client_pid}'), '');
  await assert.rejects(connection.command(['display-message','-p','x\ny']), TypeError);
  await assert.rejects(connection.command(['display-message','-p','x\0y']), TypeError);
  assert.equal(await connection.command(['display-message','-p','still alive']), 'still alive');
});
test('fixed pane survives active pane change; run mutation rejected', async t => {
  const {connection, tmux, options} = await fixture(t);
  const target = await resolveSessionTarget(options);
  assert.equal(target.runtime, 'claude'); assert.equal(target.runtimeSessionId, 's1'); assert.match(target.sessionId, /^\$/);
  const second = tmux('split-window','-d','-P','-F','#{pane_id}','-t','fixture','sleep','120');
  tmux('select-pane','-t',second);
  assert.equal(await revalidateSessionTarget({connection,target}), true); assert.notEqual(second, target.paneId);
  tmux('set-environment','-t','fixture','ZYLOS_RUN_ID','r2');
  await assert.rejects(revalidateSessionTarget({connection,target}), {code:'RUNID_MISMATCH'});
});
test('removed pane, absent target, and missing run ID fail distinctly', async t => {
  const {connection, tmux, socketPath, options} = await fixture(t);
  const target = await resolveSessionTarget(options);
  tmux('split-window','-d','-t','fixture','sleep','120'); tmux('kill-pane','-t',target.paneId);
  await assert.rejects(revalidateSessionTarget({connection,target}), {code:'TARGET_GONE'});
  const fresh=await openTmuxConnection({binary,socketPath});t.after(()=>fresh.close());
  assert.equal((await observeSessionTarget({...options,connection:fresh,tmuxName:'absent'})).present,false);
  await assert.rejects(resolveSessionTarget({...options,connection:fresh,tmuxName:'absent'}),{code:'TARGET_GONE'});
  tmux('set-environment','-u','-t','fixture','ZYLOS_RUN_ID');
  await assert.rejects(resolveSessionTarget({...options,connection:fresh}),{code:'RUNID_MISMATCH'});
});
test('F3 malformed/mismatched is not READY; snapshots immutable', async t => {
  const {options} = await fixture(t);
  assert.equal((await observeSessionTarget({...options,readReady:async()=>({runId:'r1',sessionId:'s1'})})).ready,false);
  assert.equal((await observeSessionTarget({...options,readReady:async()=>({...await ready(),runId:'other'})})).ready,false);
  const good = await observeSessionTarget(options); assert.equal(good.ready,true);
  assert.throws(()=>{good.rawF2.ZYLOS_RUN_ID='evil';},TypeError); assert.throws(()=>{good.f3.startupControlIds.push(1);},TypeError);
});
test('same socket restart fails its generation guard without replay', async t => {
  const {connection,tmux,socketPath,options} = await fixture(t);
  const target = await resolveSessionTarget(options); tmux('kill-server');
  await new Promise(resolve=>setTimeout(resolve,100));
  tmux('-f','/dev/null','new-session','-d','-s','fixture','sleep','120');
  await assert.rejects(revalidateSessionTarget({connection,target}),{code:'GENERATION_CHANGED'});
  const replacement = await openTmuxConnection({binary,socketPath}); assert.notEqual(replacement.serverGeneration,target.serverGeneration); replacement.close();
});
test('absent server differs from unexecutable transport; missing generation rejected', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-no-server-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await assert.rejects(openTmuxConnection({binary,socketPath:path.join(dir,'absent')}),{code:'TMUX_NO_SERVER'});
  await assert.rejects(openTmuxConnection({binary:path.join(dir,'missing')}),{code:'TMUX_UNAVAILABLE',cause:'error'});
  await assert.rejects(serverGeneration({command:async()=> '123:'}),{code:'TMUX_UNAVAILABLE'});
});
test('runtime fallback uses unique shallowest name and never invents config', async () => {
  const connection={command:async()=> '10'};
  const rows=[{pid:10,ppid:1,name:'node'},{pid:11,ppid:10,name:'codex.exe'},{pid:12,ppid:11,name:'claude'}];
  assert.deepEqual(await readTargetRuntime({connection,paneId:'%1',rawF2:{},readProcessTree:async()=> rows}),{runtime:'codex',launchConfig:null,runtimeObservation:'present'});
  rows.push({pid:13,ppid:10,name:'claude'});
  assert.equal((await readTargetRuntime({connection,paneId:'%1',rawF2:{},readProcessTree:async()=> rows})).runtime,'unknown');
  assert.equal((await readTargetRuntime({connection,paneId:'%1',rawF2:{ZYLOS_MODEL_CONFIG:'{"runtime":"claude"}'},readProcessTree:async()=> {throw Error('must not run');}})).runtime,'claude');
  assert.equal((await readTargetRuntime({connection,paneId:'%1',rawF2:{},readProcessTree:async()=> {throw Error('unreadable');}})).runtime,'unknown');
});
test('real Linux comm fallback recognizes a named stand-in without F2 defaults', {skip:process.platform!=='linux'}, async t => {
  const {connection,tmux,options}=await fixture(t);
  tmux('set-environment','-u','-t','fixture','ZYLOS_MODEL_CONFIG');
  // This is a stdlib stand-in, never the installed model CLI or its auth.
  tmux('respawn-pane','-k','-t','fixture','python3','-c',"import ctypes,time; ctypes.CDLL(None).prctl(15,b'codex',0,0,0); time.sleep(120)");
  let observed;
  for (let attempt=0;attempt<30;attempt++) {
    observed=await observeSessionTarget(options);
    if(observed.runtime==='codex') break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(observed.runtime,'codex'); assert.equal(observed.launchConfig,null);
  assert.equal(connection.closed,false);
});
test('initial disappearance and generation change are detected before any sending', async () => {
  let reads=0;
  const connection={bindTarget() {},command:async args=> {
    if(args[0]==='show-environment') throw Object.assign(Error("can't find session: $1"),{code:'TMUX_COMMAND_FAILED'});
    return reads++===0 ? '100:200\t$1\t%1\t123' : '100:200';
  }};
  await assert.rejects(observeSessionTarget({connection,tmuxName:'fixture',readReady:ready}),{code:'TARGET_GONE'});
  let generation='100:200';
  const held={bindTarget() {},command:async args=> {
    if(args[0]==='show-environment') return 'ZYLOS_RUN_ID=r1\nZYLOS_MODEL_CONFIG={"runtime":"claude"}';
    if(args.at(-1)==='#{pid}:#{start_time}') return generation;
    if(args.at(-1)==='#{session_id}\t#{pane_id}') return '$1\t%1';
    return '100:200\t$1\t%1\t123';
  }};
  const target=await resolveSessionTarget({connection:held,tmuxName:'fixture',readReady:ready});
  generation='101:201';
  await assert.rejects(revalidateSessionTarget({connection:held,target}),{code:'GENERATION_CHANGED'});
  await assert.rejects(revalidateSessionTarget({connection:held,target:{...target}}),TypeError);
});
test('command timeout closes executor and never accepts a retry', async t => {
  const {socketPath}=await fixture(t);
  const connection=await openTmuxConnection({binary,socketPath,timeoutMs:40});
  t.after(()=>connection.close());
  await assert.rejects(connection.command(['wait-for','unreleased-test-channel']),{code:'TMUX_UNAVAILABLE',cause:'timeout'});
  assert.equal(connection.closed,true);
  await assert.rejects(connection.command(['display-message','-p','must not replay']),{code:'TMUX_UNAVAILABLE'});
});

test('process observation distinguishes absence from ambiguity and unavailable scans', async () => {
  const connection = {command:async()=> '10'};
  const read = readProcessTree => readTargetRuntime({connection,paneId:'%1',rawF2:{},readProcessTree});
  assert.equal((await read(async()=> [{pid:10,ppid:1,name:'sh'}])).runtimeObservation, 'absent');
  assert.equal((await read(async()=> [])).runtimeObservation, 'unavailable');
  assert.equal((await read(async()=> {throw Error('denied');})).runtimeObservation, 'unavailable');
  assert.equal((await read(async()=> [{pid:10,ppid:1,name:'sh'},{pid:11,ppid:10,name:'claude'},{pid:12,ppid:10,name:'codex'}])).runtimeObservation, 'ambiguous');
});
test('last-session kill requires a session guard confirmation after the command', async t => {
  const {connection,options} = await fixture(t);
  const target = await resolveSessionTarget(options);
  await assert.rejects(connection.command(['kill-session','-t','$999999'],{kind:'session'}), {code:'TMUX_COMMAND_FAILED'});
  await connection.command(['kill-session','-t',target.tmuxSessionId],{kind:'session'});
  await assert.rejects(connection.command(['display-message','-p','-t',target.tmuxSessionId,'#{session_id}'],{kind:'session'}),{code:'TARGET_GONE'});
});
test('closed executor never sends a command', async t => {
  const {connection,options} = await fixture(t);
  const target = await resolveSessionTarget(options);
  connection.close();
  await assert.rejects(connection.command(['kill-session','-t',target.tmuxSessionId],{kind:'session'}),{code:'TMUX_UNAVAILABLE'});
});

test('absent target uses a conditional session timestamp and leaves the server alive', async t => {
  const {connection, tmux, options} = await fixture(t);
  const command = connection.command.bind(connection);
  let identityFormat;
  connection.command = async (argv, settings) => {
    if (argv.includes('=absent:')) identityFormat = argv.at(-1);
    return command(argv, settings);
  };
  assert.equal((await observeSessionTarget({...options, tmuxName:'absent'})).present, false);
  assert.equal(identityFormat.split('\t').at(-1), '#{?session_id,#{session_created},}');
  assert.equal(tmux('display-message', '-p', '-t', '=absent:', identityFormat.split('\t').at(-1)), '');
  assert.equal(tmux('display-message', '-p', '-t', '=fixture:', '#{session_name}'), 'fixture');
});

test('first resolution maps a disappearing server to TARGET_GONE', async t => {
  const {connection, tmux, options} = await fixture(t);
  tmux('kill-server');
  await assert.rejects(resolveSessionTarget(options), {code:'TARGET_GONE'});
});
