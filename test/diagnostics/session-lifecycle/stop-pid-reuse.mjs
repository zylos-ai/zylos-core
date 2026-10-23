// Run ONLY inside a fresh private PID/user/mount namespace:
// unshare --user --map-root-user --pid --fork --mount-proc node stop-pid-reuse.mjs
// The namespace-local ns_last_pid write never changes the host PID allocator.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {SessionAdapter, findRunProcesses} from '../../../cli/lib/runtime/session-adapter.js';
import {readOwnedProcess} from '../../../cli/lib/runtime/session-process-ownership.js';

assert.equal(process.pid, 1, 'requires a new private PID namespace');
const status = await fs.readFile('/proc/self/status', 'utf8');
assert.match(status, /^NSpid:\s+1$/m, 'requires namespace-local proc mount');
const runId = 'private-pid-reuse-probe';
let original, replacement, originalExit, replacementExit, before, after;
const start = async env => {
  await fs.writeFile('/proc/sys/kernel/ns_last_pid', '4000');
  const child = spawn('/bin/sleep', ['60'], {env, stdio: 'ignore'});
  const exited = once(child, 'exit');
  await once(child, 'spawn');
  assert.equal(child.pid, 4001, 'namespace PID allocator must use chosen PID');
  return {child, exited};
};
try {
  ({child: original, exited: originalExit} = await start({PATH:'/usr/bin:/bin', ZYLOS_RUN_ID:runId}));
  // Ensure different kernel start ticks without relying on a timer duration.
  before = await readOwnedProcess(original.pid, runId);
  assert.ok(before);
  const scan = key => findRunProcesses(key, {withIdentity:true,
    filesystem:{...fs, readdir:async()=>['4001']}});
  let switched = false;
  const adapter = new SessionAdapter({
    findRunProcesses:scan,
    readOwnedProcess:async (pid, key) => {
      const result = await readOwnedProcess(pid, key);
      assert.deepEqual(result, before);
      assert.equal(switched, false);
      switched = true;
      // Scheduling barrier AFTER the real final ownership read and BEFORE
      // production stop invokes its unmodified process.kill(pid, signal).
      original.kill('SIGKILL');
      await originalExit;
      // Wait for a new tick using an unrelated temporary process at another PID.
      // The repeated new PID is selected only after a different start tick exists.
      let tickAdvanced = false;
      for (let attempt=0; attempt<200; attempt++) {
        const c = spawn('/bin/sleep', ['0'], {stdio:'ignore'});
        const done = once(c, 'exit');
        const text = await fs.readFile(`/proc/${c.pid}/stat`, 'utf8').catch(()=>null);
        await done;
        if (text && text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/)[19] !== before.start) { tickAdvanced=true; break; }
      }
      assert.ok(tickAdvanced, 'could not obtain a distinct process start tick');
      ({child:replacement, exited:replacementExit} = await start({PATH:'/usr/bin:/bin', UNRELATED:'yes'}));
      const stat = await fs.readFile(`/proc/${replacement.pid}/stat`, 'utf8');
      after = {pid:replacement.pid, start:stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19]};
      assert.notEqual(after.start, before.start);
      assert.equal(await readOwnedProcess(replacement.pid, key), null);
      return result;
    },
    sleep:async()=>{},
    dependencies:{openTmuxConnection:async()=>({close(){}}),
      observeSessionTarget:async()=>({present:false})},
  });
  await adapter.stop({tmuxName:'absent-in-private-probe', expectedRunId:runId});
  const [code, signal] = await replacementExit;
  assert.equal(code, null);
  assert.equal(signal, 'SIGTERM');
  console.log(JSON.stringify({result:'counterexample-confirmed', original:before,
    replacement:after, replacementHadRunId:false, replacementExit:{code,signal},
    adapterReturned:'success', kernelPIDReuse:true,
    injectedBoundary:'scheduler barrier after real ownership read',
    scanDomain:'only independently recorded private fixture PID',
    signalImplementation:'production default process.kill'}));
} finally {
  for (const child of [replacement, original]) {
    if (child && child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
  }
}
