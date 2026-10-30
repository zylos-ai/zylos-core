import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { settleLaunch } from '../session-launch.js';
import { writeSessionLaunchScript, shellQuote } from '../session-command.js';
export const binary = process.env.TEST_TMUX_BIN || 'tmux';
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function setupLaunch(t) {
  const scripts = [];
  let server, killed = false;
  const {dir,socketPath,tmux}=isolatedTmux(t,{prefix:'session-runtime-launch-',socketName:'socket',trim:false,
    beforeCleanup:()=>{
      if (!killed && server) { try { process.kill(server, 'SIGCONT'); } catch {} }
      for (const script of scripts) script.cleanup();
    }});
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', 'sleep 60');
  server = Number(tmux('display-message', '-p', '#{pid}').trim());
  function killFrozenServer() { if (!killed) { process.kill(server, 'SIGKILL'); killed = true; } }
  async function launch({command='/bin/sleep', args=['30'], tmuxName='target', sessionGroup=null,
    launchConfig={runtime:'claude', mode:'default'}, runId='isolated-run', tmuxBinary=binary}={}) {
    const script = writeSessionLaunchScript({command, args, env:{PATH:process.env.PATH}, root:dir, multi:sessionGroup!==null});
    scripts.push(script);
    return settleLaunch({tmuxName, runId, launchConfig, sessionGroup, root:dir, script,
      tmux:{binary:tmuxBinary, socketPath, configFile:'/dev/null'}});
  }
  async function clientWrapper(replacement) {
    const file = path.join(dir, 'tmux-wrapper');
    const pidFile = path.join(dir, 'client-pid');
    const calls = path.join(dir, 'client-calls');
    await fs.writeFile(file, `#!/bin/bash\nprintf '%s\\n' "$$" > ${shellQuote(pidFile)}\nprintf '%s\\n' \"$*\" >> ${shellQuote(calls)}\nargs=("$@")\n${replacement===undefined ? '' : `for ((i=0; i<\${#args[@]}; i++)); do\n  if [[ "\${args[$i]}" == ZYLOS_MODEL_CONFIG=* ]]; then args[$i]=${shellQuote('ZYLOS_MODEL_CONFIG='+JSON.stringify(replacement))}; fi\ndone\n`}exec ${shellQuote(binary)} "\${args[@]}"\n`, {mode:0o700});
    return {file,pidFile,calls};
  }
  return {dir, socketPath, server, tmux, launch, clientWrapper, killFrozenServer};
}
export function assertGone(assert, pid) {
  assert.throws(() => process.kill(pid, 0), {code:'ESRCH'}, `tmux client ${pid} must exit before settlement`);
}
