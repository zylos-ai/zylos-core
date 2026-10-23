import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { adapterError, runtimeExecutable, shellQuote } from './session-command.js';
import { readProcessImage } from './session-process-observation.js';

// Establish the final exec image before submitting any mutation. Script runtimes
// use their shebang interpreter; the exact script and argument tail are checked.
export async function executableIdentity(command, env) {
  if (process.platform !== 'linux') throw adapterError('LAUNCH_FAILED','Exec observation unavailable on this platform');
  const bytes = await fs.readFile(command);
  let executable = command;
  if (bytes.subarray(0,2).toString() === '#!') {
    const words = bytes.toString('utf8',0,256).split('\n')[0].slice(2).trim().split(/\s+/);
    executable = words[0];
    if (executable.endsWith('/env')) {
      if (words.length !== 2 || words[1].startsWith('-')) throw adapterError('LAUNCH_FAILED','Unsupported runtime interpreter');
      executable = runtimeExecutable(words[1],env);
    }
  }
  return {executable:await fs.realpath(executable),command};
}
const formatLiteral = value => String(value).replaceAll('#','##').replaceAll(',','#,').replaceAll('}','#}');

/** One submitted creation, one held control connection, no cancellation fiction.
 * A notice is advisory. Loss of the connection before proof retains the promise.
 */
export function settleLaunch({tmuxName,runId,launchConfig,sessionGroup,root,script,identity,args,tmux={},noticeMs=3000,onNotice=console.warn}) {
  const socket = tmux.socketPath ? ['-S',tmux.socketPath] : tmux.socketName ? ['-L',tmux.socketName] : [];
  if (tmux.socketPath && tmux.socketName) { script.cleanup(); throw new TypeError('Choose one tmux socket'); }
  // Multi-mode observes F2 in the creation command itself. Single-mode also
  // requires a session-local removal proof on this same control connection.
  // The literal modifier also bypasses tmux style handling for #[...].
  const equal = (key,value) => `#{==:#{${key}},#{l:${formatLiteral(value)}}}`;
  const format = ['#{session_id}','#{pane_id}','#{pane_pid}','#{session_created}',
    equal('ZYLOS_RUN_ID',runId),equal('ZYLOS_MODEL_CONFIG',JSON.stringify(launchConfig)),
    equal('ZYLOS_SESSION_GROUP',sessionGroup ?? '')].join('\t');
  const argv = [...socket,...(tmux.configFile ? ['-f',tmux.configFile] : []),'-C','new-session','-P','-F',format,'-s',tmuxName,'-c',root,
    '-e',`ZYLOS_RUN_ID=${runId}`,'-e',`ZYLOS_MODEL_CONFIG=${JSON.stringify(launchConfig)}`,
    '-e',sessionGroup === null ? 'ZYLOS_SESSION_GROUP' : `ZYLOS_SESSION_GROUP=${sessionGroup}`,
    `exec /bin/sh ${shellQuote(script.file)}`];
  return new Promise((resolve,reject) => {
    const child = spawn(tmux.binary || 'tmux',argv,{stdio:['pipe','pipe','pipe']});
    let frame,buffer='',phase='create',target,environmentConfirmed=false,settled=false,closed=false,start;
    let interval,checking=false;
    const notice = setTimeout(() => { try { onNotice('Launch remains pending; original tmux request is retained'); } catch {} },noticeMs);
    function finish(error) {
      if (settled) return;
      settled=true; clearTimeout(notice); clearInterval(interval);
      // Creation has acknowledged before pane-exit failure or exec success.
      // A queued tombstone can only address that original immutable session ID;
      // it cannot create a process or touch a same-name replacement. Closing
      // this client only detaches it, never proves cancellation.
      const complete = () => { script.cleanup(); error ? reject(error) : resolve({tmuxName,createdAt:target.createdAt}); };
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) complete();
      else { child.once('close',complete); child.stdin.destroy(); child.kill(); }
    }
    function send(words) {
      if (closed || settled) return;
      try { child.stdin.write(words.map(shellQuote).join(' ')+'\n'); }
      catch { closed=true; }
    }
    async function inspect() {
      if (checking || settled || !target) return;
      checking=true;
      try {
        const image=await readProcessImage(target.pid);
        // An acknowledged creation includes its already-forked pane PID: if
        // that process is gone it cannot later exec. Never infer this pre-ack.
        if (image.gone) { finish(adapterError('LAUNCH_FAILED','Runtime exited before exec could be confirmed')); return; }
        if (start !== undefined && image.start !== undefined && image.start !== start) { finish(adapterError('LAUNCH_FAILED','Original launch process exited')); return; }
        start ??= image.start;
        if (image.uncertain) return;
        const wanted=[identity.command,...args];
        const actual=image.argv.slice(-wanted.length);
        if (environmentConfirmed && image.cwd === root && image.env.includes(`ZYLOS_RUN_ID=${runId}`) && image.env.includes(`ZYLOS_MODEL_CONFIG=${JSON.stringify(launchConfig)}`) && (sessionGroup === null ? !image.env.some(v=>v.startsWith('ZYLOS_SESSION_GROUP=')) : image.env.includes(`ZYLOS_SESSION_GROUP=${sessionGroup}`)) && image.exe === identity.executable && actual.length === wanted.length && actual.every((v,i)=>v===wanted[i])) finish();
      } finally {checking=false;}
    }
    child.on('error',error => {
      // A spawn error proves no tmux client existed; unlike disconnect, this is
      // safe to settle without observing a server.
      if (!child.pid) finish(adapterError('LAUNCH_FAILED',error.message));
    });
    child.stdin.on('error',()=>{closed=true;});
    child.on('close',()=>{closed=true;});
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',data => {
      buffer+=data;
      let end;
      while ((end=buffer.indexOf('\n')) !== -1) {
        const line=buffer.slice(0,end).replace(/\r$/,''); buffer=buffer.slice(end+1);
        if (line.startsWith('%begin ')) {frame={id:line.slice(7),lines:[]};continue;}
        if (frame && (line.startsWith('%end ') || line.startsWith('%error '))) {
          if (line.slice(line.indexOf(' ')+1)!==frame.id) {closed=true;continue;}
          const result=frame.lines.join('\n'),error=line.startsWith('%error '),control=frame.id.split(' ').at(-1)==='1'; frame=null;
          if (phase==='create') {
            if (error) {finish(adapterError(/duplicate session/.test(result)?'NAME_CONFLICT':'LAUNCH_FAILED',result));continue;}
            const m=result.match(/^(\$\d+)\t(%\d+)\t(\d+)\t(\d+)\t([01])\t([01])\t([01])$/);
            if (!m) {phase='unknown';continue;}
            target={session:m[1],pane:m[2],pid:Number(m[3]),createdAt:Number(m[4])};
            phase=sessionGroup===null ? 'remove-group' : 'observe';
            environmentConfirmed=sessionGroup!==null && m[5]==='1' && m[6]==='1' && m[7]==='1';
            // -e KEY does not remove inherited tmux environment. Install a
            // session-local tombstone, always targeting the ACK's immutable ID.
            // The generated launch script independently uses env -i so its
            // original runtime never inherits the stale single-mode variable.
            if (sessionGroup===null) send(['set-environment','-r','-t',target.session,'ZYLOS_SESSION_GROUP']);
            interval=setInterval(inspect,25); void inspect();
          } else if (control && ['remove-group','prove-target','prove-absence'].includes(phase)) {
            // Commands submitted on control stdin have flag 1; configured
            // hooks have flag 0 and cannot impersonate these serialized ACKs.
            // Loss/error/malformed proof never permits success or rebinding.
            if (error) {phase='unknown';continue;}
            if (phase==='remove-group') {
              if (result!=='') {phase='unknown';continue;}
              phase='prove-target';
              // list-panes does not apply display-message's recursive strftime
              // expansion to literal model values. Select only the original
              // pane within the original session; never use the current target.
              send(['list-panes','-s','-t',target.session,'-f',equal('pane_id',target.pane),'-F',format+'\t'+equal('session_name',tmuxName)]);
            } else if (phase==='prove-target') {
              const expected=[target.session,target.pane,target.pid,target.createdAt,1,1,1,1].join('\t');
              if (result!==expected) {phase='unknown';continue;}
              phase='prove-absence';
              send(['show-environment','-t',target.session,'ZYLOS_SESSION_GROUP']);
            } else {
              environmentConfirmed=result==='-ZYLOS_SESSION_GROUP';
              phase='observe';void inspect();
            }
          }
          continue;
        }
        if (frame) frame.lines.push(line);
      }
    });
  });
}
