import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';

const identity = new URL('../../../../skills/activity-monitor/scripts/bootstrap-identity.js', import.meta.url).href;
const runtimeBase = new URL('../', import.meta.url).href;
const pathsModule = new URL('../../session-group-paths.js', import.meta.url).href;

function probe(f, scope = { kind: 'multi', sessionGroup: 'origin' }) {
  const script = path.join(f.root, 'probe.mjs');
  const result = path.join(f.root, 'identity.json');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import {readBootstrapIdentity} from ${JSON.stringify(identity)};
import {openTmuxConnection} from ${JSON.stringify(`${runtimeBase}tmux-connection.js`)};
const load = name => import(name === 'session-group-paths.js' ? ${JSON.stringify(pathsModule)} : ${JSON.stringify(runtimeBase)} + name.replace('runtime/',''));
const publish = data => {
  fs.writeFileSync(${JSON.stringify(`${result}.tmp`)}, JSON.stringify(data));
  fs.renameSync(${JSON.stringify(`${result}.tmp`)}, ${JSON.stringify(result)});
};
try {
  const data = await readBootstrapIdentity(${JSON.stringify(scope)}, {
    load, open: () => openTmuxConnection({binary:${JSON.stringify(f.binary)},socketPath:${JSON.stringify(f.socketPath)}}),
  });
  publish({ok:true,data});
} catch (error) {
  publish({ok:false,code:error.code,message:error.message});
}
`);
  return { script, result };
}

for (const runtime of ['claude', 'codex']) {
test(`Bootstrap accepts the bound ${runtime} managed run`, async t => {
  const f = readyTmuxTarget(t, { prefix: 'bootstrap-real-', mode: 'multi', runtime, ledger: false });
  const p = probe(f);
  f.tmux('respawn-pane', '-k', '-t', '=zylos-group-origin:', process.execPath, p.script);
  for (let i = 0; i < 200 && !fs.existsSync(p.result); i++) await delay(20);
  const observed = JSON.parse(fs.readFileSync(p.result, 'utf8'));
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.data.runtime, runtime);
  assert.equal(observed.data.tmuxName, 'zylos-group-origin');
  assert.equal(observed.data.runId, 'run-1');
});

test(`Bootstrap rejects a stale ${runtime} run ID`, t => {
  const f = readyTmuxTarget(t, { prefix: 'bootstrap-outsider-', mode: 'multi', runtime, ledger: false });
  const p = probe(f);
  const paneId = f.tmux('display-message', '-p', '-t', '=zylos-group-origin:', '#{pane_id}');
  execFileSync(process.execPath, [p.script], {
    env: { ...f.env, ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: 'old-run', TMUX_PANE: paneId },
    timeout: 10000,
  });
  const observed = JSON.parse(fs.readFileSync(p.result, 'utf8'));
  assert.deepEqual(observed, { ok: false, code: 'IDENTITY_UNAVAILABLE', message: 'Hook is not in the current managed runtime pane' });
});

test(`Legacy Bootstrap accepts a ${runtime} pane ancestor and rejects an outsider (M12)`, async t => {
  const f = readyTmuxTarget(t, { prefix: 'bootstrap-legacy-', runtime, ledger: false });
  const tmuxName = `${runtime}-main`;
  f.tmux('rename-session', '-t', '=zylos-group-origin', tmuxName);
  f.tmux('set-environment', '-u', '-t', `=${tmuxName}`, 'ZYLOS_RUN_ID');
  // Keep a native parent alive so process names come from the OS, not node argv.
  const native = path.join(f.root, runtime);
  const source = path.join(f.root, 'parent.c');
  fs.writeFileSync(source, '#include <unistd.h>\n#include <sys/wait.h>\nint main(int n,char **v){pid_t p=fork();if(p==0){execv(v[1],v+1);_exit(127);}int s;waitpid(p,&s,0);return 0;}\n');
  execFileSync('cc', [source, '-o', native], { timeout: 20000 });
  const p = probe(f, { kind: 'legacy', sessionGroup: null });
  const paneId = f.tmux('display-message', '-p', '-t', `=${tmuxName}:`, '#{pane_id}');
  execFileSync(native, [process.execPath, p.script], {
    env: { ...f.env, TMUX_PANE: paneId }, timeout: 10000,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.result, 'utf8')),
    { ok: false, code: 'IDENTITY_UNAVAILABLE', message: 'Hook is not in the current managed runtime pane' });
  fs.unlinkSync(p.result);
  f.tmux('respawn-pane', '-k', '-t', `=${tmuxName}:`, native, process.execPath, p.script);
  for (let i = 0; i < 200 && !fs.existsSync(p.result); i++) await delay(20);
  const observed = JSON.parse(fs.readFileSync(p.result, 'utf8'));
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.data.runtime, runtime);
  assert.equal(observed.data.tmuxName, tmuxName);
  assert.equal(observed.data.runId, null);
  assert.ok(observed.data.runtimePid > 1);
});
}

function legacyNamedParent(f) {
  const native = path.join(f.root, 'claude');
  const source = path.join(f.root, 'confirmation-parent.c');
  fs.writeFileSync(source, `#include <unistd.h>
#include <sys/wait.h>
#include <sys/prctl.h>
int main(int argc,char **argv){
  if(argc<4 || prctl(PR_SET_NAME,argv[1],0,0,0))return 125;
  pid_t child=fork();
  if(child==0){execv(argv[2],argv+2);_exit(127);}
  if(child<0)return 126;
  int status;waitpid(child,&status,0);
  sleep(120);return 0;
}
`);
  execFileSync('cc', [source, '-o', native], { timeout: 20000 });
  return native;
}

function legacyClaudePane(f) {
  f.tmux('rename-session', '-t', '=zylos-group-origin', 'claude-main');
  f.tmux('set-environment', '-u', '-t', '=claude-main', 'ZYLOS_RUN_ID');
}

async function readProbeResult(p) {
  for (let attempt = 0; attempt < 750 && !fs.existsSync(p.result); attempt++) await delay(20);
  assert.equal(fs.existsSync(p.result), true, 'legacy identity probe did not finish');
  return JSON.parse(fs.readFileSync(p.result, 'utf8'));
}

// Boundary: real Linux task names on a private legacy tmux pane. Run for
// ancestor-name confirmation changes; unrelated work may skip. Fixture owns cleanup.
test('Legacy Bootstrap confirms the kernel task name instead of a ps basename', {skip:process.platform !== 'linux',timeout:30000}, async t => {
  const f = readyTmuxTarget(t, {prefix:'bootstrap-kernel-name-',ledger:false});
  legacyClaudePane(f);
  const native = legacyNamedParent(f);
  const p = probe(f, {kind:'legacy',sessionGroup:null});
  f.tmux('respawn-pane', '-k', '-t', '=claude-main:', native, 'claude', process.execPath, p.script);
  const accepted = await readProbeResult(p);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.data.runtime, 'claude');
  assert.equal(accepted.data.runtimePid, Number(f.tmux('display-message','-p','-t','=claude-main:','#{pane_pid}')));

  fs.unlinkSync(p.result);
  f.tmux('respawn-pane', '-k', '-t', '=claude-main:', native, 'x/claude', process.execPath, p.script);
  const rejected = await readProbeResult(p);
  const panePid = Number(f.tmux('display-message','-p','-t','=claude-main:','#{pane_pid}'));
  assert.equal(fs.readFileSync(`/proc/${panePid}/comm`,'utf8').trim(), 'x/claude');
  const psName = execFileSync('ps',['-o','comm=','-p',String(panePid)],{encoding:'utf8'}).trim();
  assert.equal(path.basename(psName), 'claude', 'the unconfirmed ps basename would falsely match');
  assert.deepEqual(rejected, {ok:false,code:'IDENTITY_UNAVAILABLE',message:'Hook is not in the current managed runtime pane'});
  assert.doesNotThrow(() => f.tmux('has-session','-t','=claude-main'));
});

// Boundary: stale ancestry versus real process exit while its private pane lives.
// Run for ancestor snapshot/confirmation changes; unrelated work may skip.
// Fixture and probe cleanup are bounded.
test('Legacy Bootstrap drops an exited ancestor from the original real process snapshot', {skip:process.platform !== 'linux',timeout:30000}, async t => {
  let script, pidFile;
  // Register before the tmux fixture removes its private directory and marker.
  t.after(async () => {
    if (!pidFile || !fs.existsSync(pidFile)) return;
    const pid = Number(fs.readFileSync(pidFile,'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    let argv;
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return; throw error; }
    if (!argv.includes(script)) return;
    try { process.kill(pid,'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (fs.readFileSync(`/proc/${pid}/status`,'utf8').match(/^State:\s+Z/m)) return;
      } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return; throw error; }
      await delay(10);
    }
    assert.fail('private legacy identity probe did not stop after SIGKILL');
  });
  const f = readyTmuxTarget(t, {prefix:'bootstrap-exited-ancestor-',ledger:false});
  legacyClaudePane(f);
  const native = legacyNamedParent(f);
  script = path.join(f.root,'stale-ancestor-probe.mjs');
  pidFile = path.join(f.root,'stale-ancestor-probe.pid');
  const result = path.join(f.root,'stale-ancestor-result.json');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {readBootstrapIdentity} from ${JSON.stringify(identity)};
import {readProcessTree} from ${JSON.stringify(`${runtimeBase}session-target.js`)};
import {openTmuxConnection} from ${JSON.stringify(`${runtimeBase}tmux-connection.js`)};
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const scope = {kind:'legacy',sessionGroup:null};
const load = name => import(name === 'session-group-paths.js' ? ${JSON.stringify(pathsModule)} : ${JSON.stringify(runtimeBase)} + name.replace('runtime/',''));
const options = {load,open:()=>openTmuxConnection({binary:${JSON.stringify(f.binary)},socketPath:${JSON.stringify(f.socketPath)}})};
let output;
try {
  const runtimePid = process.ppid;
  const accepted = await readBootstrapIdentity(scope,options);
  // A new snapshot retains readProcessTree's WeakMap provenance without any
  // cached confirmations from the preceding positive-control observation.
  const snapshot = await readProcessTree();
  const staleAncestor = {...snapshot.find(row=>row.pid===runtimePid)};
  process.kill(runtimePid,'SIGKILL');
  for(let attempt=0;attempt<200 && fs.existsSync('/proc/'+runtimePid);attempt++)await delay(10);
  const ancestorGone = !fs.existsSync('/proc/'+runtimePid);
  let rejected;
  try { rejected = {data:await readBootstrapIdentity(scope,{...options,processTree:async()=>snapshot})}; }
  catch(error){rejected={code:error.code,message:error.message};}
  output={accepted,runtimePid,staleAncestor,ancestorGone,rejected};
} catch(error){output={error:{code:error.code,message:error.message}};}
fs.writeFileSync(${JSON.stringify(`${result}.tmp`)},JSON.stringify(output));
fs.renameSync(${JSON.stringify(`${result}.tmp`)},${JSON.stringify(result)});
`);
  // The pane shell reaps the runtime child, then remains alive as sleep. The
  // orphaned probe retains its original snapshot while the native ancestor exits.
  const launch = `"${native}" claude "${process.execPath}" "${script}" & wait; exec sleep 120`;
  f.tmux('respawn-pane','-k','-t','=claude-main:','sh','-c',launch);
  const panePid = Number(f.tmux('display-message','-p','-t','=claude-main:','#{pane_pid}'));
  const observed = await readProbeResult({result});
  assert.equal(observed.error, undefined, JSON.stringify(observed));
  assert.equal(observed.accepted.runtime, 'claude');
  assert.equal(observed.accepted.runtimePid, observed.runtimePid);
  assert.equal(observed.staleAncestor.pid, observed.runtimePid);
  assert.equal(observed.staleAncestor.ppid, panePid, 'the exited runtime was really inside this pane');
  assert.equal(observed.staleAncestor.name, 'claude');
  assert.equal(observed.ancestorGone, true, 'the shell must reap the runtime before testing the stale snapshot');
  assert.equal(fs.existsSync(`/proc/${panePid}`), true, 'the pane root must survive the ancestor exit');
  assert.equal(Number(f.tmux('display-message','-p','-t','=claude-main:','#{pane_pid}')), panePid);
  assert.deepEqual(observed.rejected, {code:'IDENTITY_UNAVAILABLE',message:'Hook is not in the current managed runtime pane'});
  assert.doesNotThrow(() => f.tmux('has-session','-t','=claude-main'));
});
