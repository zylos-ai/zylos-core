import { spawn } from 'node:child_process';
import { adapterError, shellQuote } from './session-command.js';
import { tmuxClientArgs } from './tmux-client-args.js';

// Match the shared tmux connection's observation budget. Cleanup has its own
// short bound so a frozen server cannot keep the caller or its client alive.
export const LAUNCH_TIMEOUT_MS = 3000;
export const LAUNCH_CLEANUP_TIMEOUT_MS = 500;
const EXEC_POLL_MS = 25;
const formatLiteral = value => String(value).replaceAll('#','##').replaceAll(',','#,').replaceAll('}','#}');
const startingCommands = new Set(['sh','dash','bash','zsh','ksh','ash','fish','env','tmux','tmux: server']);

/** Submit once, observe on that client, and release all local work before return.
 * A request already held by an unobservable server may still execute later;
 * that server-side outcome belongs to the router, not a background launcher.
 */
export function settleLaunch({tmuxName,runId,launchConfig,sessionGroup,root,script,tmux={}}) {
  let clientArgs;
  try { clientArgs = tmuxClientArgs(tmux); }
  catch (error) { script.cleanup(); throw error; }
  const equal = (key,value) => `#{==:#{${key}},#{l:${formatLiteral(value)}}}`;
  const format = ['#{session_id}','#{pane_id}','#{pane_pid}','#{session_created}',
    equal('ZYLOS_RUN_ID',runId),equal('ZYLOS_MODEL_CONFIG',JSON.stringify(launchConfig)),
    equal('ZYLOS_SESSION_GROUP',sessionGroup ?? '')].join('\t');
  const argv = [...clientArgs,...(tmux.configFile ? ['-f',tmux.configFile] : []),'-C','new-session','-P','-F',format,'-s',tmuxName,'-c',root,
    '-e',`ZYLOS_RUN_ID=${runId}`,'-e',`ZYLOS_MODEL_CONFIG=${JSON.stringify(launchConfig)}`,
    '-e',sessionGroup === null ? 'ZYLOS_SESSION_GROUP' : `ZYLOS_SESSION_GROUP=${sessionGroup}`,
    `exec /bin/sh ${shellQuote(script.file)}`];
  return new Promise((resolve,reject) => {
    const child = spawn(tmux.binary || 'tmux',argv,{stdio:['pipe','pipe','pipe']});
    let buffer='', frame, target, closed=false, cleaning=false, finishing=false, pollTimer, cleanupTimer, lastCommand;
    let failure;
    const pending=['create'];
    const clientExit = new Promise(done => {
      child.once('exit',done);
      child.once('error',() => { if (!child.pid) done(); });
    });
    const deadline=setTimeout(() => fail(adapterError('LAUNCH_FAILED','Launch confirmation timed out','timeout')),LAUNCH_TIMEOUT_MS);
    async function finish(error) {
      if (finishing) return;
      finishing=true;
      clearTimeout(deadline); clearTimeout(pollTimer); clearTimeout(cleanupTimer);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      // This is our short-lived tmux client, never the pane/runtime process.
      if (child.pid && child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
      await clientExit;
      try { script.cleanup(); }
      catch (cleanupError) { error ??= adapterError('LAUNCH_FAILED',cleanupError.message); }
      error ? reject(error) : resolve({tmuxName,createdAt:target.createdAt});
    }
    function send(kind,words) {
      if (closed || finishing || child.stdin.destroyed || !child.stdin.writable) return false;
      pending.push(kind);
      try { child.stdin.write(words.map(shellQuote).join(' ')+'\n'); }
      catch { pending.pop(); closed=true; return false; }
      return true;
    }
    function fail(error) {
      if (cleaning || finishing) return;
      cleaning=true; failure=error;
      clearTimeout(deadline); clearTimeout(pollTimer);
      // Never reconnect: session IDs can be reused by a replacement server.
      // A dead/unwritable original transport cannot confirm cleanup; the router
      // handles that unobservable outcome after this bounded failure returns.
      if (target && send('kill',['kill-session','-t',target.session])) {
        cleanupTimer=setTimeout(() => void finish(error),LAUNCH_CLEANUP_TIMEOUT_MS);
      } else void finish(error);
    }
    function inspect() {
      if (cleaning || finishing) return;
      if (!send('inspect',['display-message','-p','-t',target.pane,
        '#{session_id}\t#{pane_id}\t#{pane_dead}\t#{pane_current_command}'])) {
        fail(adapterError('LAUNCH_FAILED','Launch observation connection closed'));
      }
    }
    function reply(kind,result,error) {
      if (cleaning) { if (kind==='kill') void finish(failure); return; }
      if (kind==='create') {
        if (error) { fail(adapterError(/duplicate session/.test(result)?'NAME_CONFLICT':'LAUNCH_FAILED',result)); return; }
        // Retain a valid object address even if later receipt fields are
        // malformed, so validation failure still cleans up our created session.
        const address=result.match(/^(\$\d+)\t(%\d+)\t/);
        if (address) target={session:address[1],pane:address[2]};
        const m=result.match(/^(\$\d+)\t(%\d+)\t(\d+)\t(\d+)\t([01])\t([01])\t([01])$/);
        if (!m) { fail(adapterError('LAUNCH_FAILED','Invalid tmux creation receipt')); return; }
        target={session:m[1],pane:m[2],createdAt:Number(m[4])};
        if (!Number.isSafeInteger(target.createdAt) || m[5]!=='1' || m[6]!=='1' || (sessionGroup!==null && m[7]!=='1')) {
          fail(adapterError('LAUNCH_FAILED','Launch environment was not confirmed')); return;
        }
        if (sessionGroup===null) {
          if (!send('single',['set-environment','-r','-t',target.session,'ZYLOS_SESSION_GROUP'])) fail(adapterError('LAUNCH_FAILED','Launch connection closed'));
        } else inspect();
      } else if (kind==='single') {
        if (error) fail(adapterError('LAUNCH_FAILED','Cannot clear single-session group environment'));
        else inspect();
      } else if (kind==='inspect') {
        const m=result.match(/^(\$\d+)\t(%\d+)\t([01])\t([^\t\r\n]*)$/);
        if (error || !m || m[1]!==target.session || m[2]!==target.pane || m[3]!=='0') {
          fail(adapterError('LAUNCH_FAILED','Runtime exited before exec confirmation')); return;
        }
        const command=m[4];
        const started=command && !startingCommands.has(command.replace(/^-/,'').split('/').at(-1));
        // Two observations separated by one poll reject immediate exits and
        // let shell/env wrappers finish exec without inspecting a /proc image.
        if (started && lastCommand===command) { void finish(); return; }
        lastCommand=started ? command : undefined;
        pollTimer=setTimeout(inspect,EXEC_POLL_MS);
      } else fail(adapterError('LAUNCH_FAILED','Unexpected tmux reply'));
    }
    child.on('error',error => fail(adapterError('LAUNCH_FAILED',error.message)));
    child.stdin.on('error',() => { closed=true; cleaning ? void finish(failure) : fail(adapterError('LAUNCH_FAILED','Launch connection closed')); });
    child.on('exit',() => { closed=true; });
    // `exit` may precede the last buffered stdout frame (notably a duplicate
    // name error). Let the streams drain before diagnosing an early exit.
    // The deadline still bounds clients whose descendants retain a pipe.
    child.on('close',() => {
      if (!finishing) cleaning ? void finish(failure) : fail(adapterError('LAUNCH_FAILED','Launch client exited before confirmation'));
    });
    child.stdout.on('error',error => fail(adapterError('LAUNCH_FAILED',error.message)));
    child.stderr.on('error',error => fail(adapterError('LAUNCH_FAILED',error.message)));
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',data => {
      if (finishing) return;
      buffer+=data;
      let end;
      while (!finishing && (end=buffer.indexOf('\n'))!==-1) {
        const line=buffer.slice(0,end).replace(/\r$/,''); buffer=buffer.slice(end+1);
        if (line.startsWith('%begin ')) {
          if (frame) { fail(adapterError('LAUNCH_FAILED','Invalid tmux response frame')); return; }
          frame={id:line.slice(7),lines:[]}; continue;
        }
        if (frame && (line.startsWith('%end ') || line.startsWith('%error '))) {
          if (line.slice(line.indexOf(' ')+1)!==frame.id) { fail(adapterError('LAUNCH_FAILED','Invalid tmux response frame')); return; }
          const result=frame.lines.join('\n'); frame=null;
          reply(pending.shift(),result,line.startsWith('%error ')); continue;
        }
        if (frame) frame.lines.push(line);
      }
    });
  });
}
