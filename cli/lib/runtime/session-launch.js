import { adapterError, shellQuote } from './session-command.js';
import { openTmuxConnection, runTmuxCommand } from './tmux-connection.js';
import { TMUX_COMMAND as C, TMUX_FORMAT as F, launchFormat, parseLaunchAddress,
  parseLaunchReceipt, parseExecReceipt } from './tmux-protocol.js';

export const LAUNCH_TIMEOUT_MS = 3000;
export const LAUNCH_CLEANUP_TIMEOUT_MS = 500;
const EXEC_POLL_MS = 25;
const startingCommands = new Set(['sh','dash','bash','zsh','ksh','ash','fish','env','tmux','tmux: server']);

/** Submit once and bound all confirmation and local cleanup before return. */
export async function settleLaunch({tmuxName,runId,launchConfig,sessionGroup,root,script,tmux={}}) {
  const deadline = performance.now() + LAUNCH_TIMEOUT_MS;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw adapterError('LAUNCH_FAILED','Launch confirmation timed out','timeout');
    return ms;
  };
  let target, connection;
  const retainAddress = receipt => {
    const address = parseLaunchAddress(receipt);
    if (address) target = {serverGeneration:address[1],tmuxSessionId:address[2],paneId:address[3]};
  };
  const format = launchFormat(runId, launchConfig, sessionGroup);
  try {
    const receipt = await runTmuxCommand([C.newSession,'-d','-P','-F',format,'-s',tmuxName,'-c',root,
      '-e',`ZYLOS_RUN_ID=${runId}`,'-e',`ZYLOS_MODEL_CONFIG=${JSON.stringify(launchConfig)}`,
      '-e',sessionGroup === null ? 'ZYLOS_SESSION_GROUP' : `ZYLOS_SESSION_GROUP=${sessionGroup}`,
      `exec /bin/sh ${shellQuote(script.file)}`], {...tmux,timeoutMs:remaining(),noServerStart:false}).catch(error => {
        // The server may create the object before the client reports an error.
        retainAddress(error.stdout);
        throw error;
      });
    // Preserve a valid server/object address even if environment confirmation
    // fails, so cleanup can only affect the session created by this request.
    retainAddress(receipt);
    const match = parseLaunchReceipt(receipt);
    if (!match) throw adapterError('LAUNCH_FAILED','Invalid tmux creation receipt');
    target.createdAt = Number(match[5]);
    if (!Number.isSafeInteger(target.createdAt) || match[6] !== '1' || match[7] !== '1' || (sessionGroup !== null && match[8] !== '1')) {
      throw adapterError('LAUNCH_FAILED','Launch environment was not confirmed');
    }
    connection = await openTmuxConnection({...tmux,timeoutMs:remaining()});
    connection.bindTarget(target);
    const command = argv => connection.command(argv,{timeoutMs:remaining()});
    if (sessionGroup === null) await command([C.setEnvironment,'-r','-t',target.tmuxSessionId,'ZYLOS_SESSION_GROUP']);
    let lastCommand;
    while (true) {
      const output = await command([C.displayMessage,'-p','-t',target.paneId, F.exec]);
      const observed = parseExecReceipt(output);
      if (!observed || observed[1] !== target.tmuxSessionId || observed[2] !== target.paneId || observed[3] !== '0') {
        throw adapterError('LAUNCH_FAILED','Runtime exited before exec confirmation');
      }
      const name = observed[4];
      const started = name && !startingCommands.has(name.replace(/^-/,'').split('/').at(-1));
      if (started && lastCommand === name) return {tmuxName,createdAt:target.createdAt};
      lastCommand = started ? name : undefined;
      await new Promise(resolve => setTimeout(resolve,Math.min(EXEC_POLL_MS,remaining())));
    }
  } catch (error) {
    connection?.close();
    // Use the creation receipt's identity, never a fresh lookup by name. A
    // replacement server fails the guard and cannot be cleaned up as our own.
    if (target) {
      let cleanup;
      const end = performance.now() + LAUNCH_CLEANUP_TIMEOUT_MS;
      try {
        cleanup = await openTmuxConnection({...tmux,timeoutMs:LAUNCH_CLEANUP_TIMEOUT_MS});
        cleanup.bindTarget(target);
        const timeoutMs = Math.ceil(end - performance.now());
        if (timeoutMs > 0) await cleanup.command([C.killSession,'-t',target.tmuxSessionId],{kind:'session',timeoutMs});
      } catch { /* Unobservable server-side outcomes are handled by the caller. */ }
      finally { cleanup?.close(); }
    }
    if (error.code === 'NAME_CONFLICT' || error.code === 'LAUNCH_FAILED') throw error;
    if (/duplicate session/.test(error.message)) throw adapterError('NAME_CONFLICT',error.message);
    throw adapterError('LAUNCH_FAILED',error.message,error.cause);
  } finally {
    connection?.close();
    script.cleanup();
  }
}
