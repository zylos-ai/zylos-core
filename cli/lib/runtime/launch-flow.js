import fs from 'node:fs/promises';
import { getRuntime } from './index.js';
import { connection as openConnection, dependencies } from './session-ops.js';
import { adapterError, runtimeExecutable, runtimeHelpAsync, validateLaunchConfig, launchEnvironment, shellQuote, writeSessionLaunchScript } from './session-command.js';
import { applyUpgradePrompt, discoverUpgradeContext } from './upgrade-context.js';
import { ZYLOS_DIR } from '../config.js';
import { isTmuxDirectoryError } from './tmux-client-args.js';
import { openTmuxConnection, runTmuxCommand } from './tmux-connection.js';
import { TMUX_COMMAND as C, TMUX_FORMAT as F, launchFormat, parseLaunchAddress,
  parseLaunchReceipt, parseExecReceipt } from './tmux-protocol.js';
import { groupRunDir } from '../session-group-paths.js';
import { readProcessStart } from '../../../skills/activity-monitor/scripts/claude-pid.js';
import { writePaneProcess } from '../../../skills/activity-monitor/scripts/pane-process.js';

export const LAUNCH_TIMEOUT_MS = 10000;
export const LAUNCH_CLEANUP_TIMEOUT_MS = 500;
const EXEC_POLL_MS = 25;
const startingCommands = new Set(['sh','dash','bash','zsh','ksh','ash','fish','env','tmux','tmux: server']);

/**
 * Record the pane process of this run before the runtime can fire a hook. The
 * pane command execs the runtime, so pid and start time stay the runtime's.
 * Without the record hooks cannot tell the pane process from a child runtime
 * and keep running (with a logged reason), so a failed write never fails the launch.
 */
export function recordPaneProcess({runId,launchConfig,sessionGroup,root,panePid,readStart=readProcessStart,write=writePaneProcess}) {
  try {
    const paneStart = readStart(panePid);
    if (paneStart === null) return null;
    return write(groupRunDir(sessionGroup ?? 'origin',{ZYLOS_DIR:root}),{runId,runtime:launchConfig?.runtime,panePid,paneStart});
  } catch { return null; }
}

/** Submit once and bound all confirmation and local cleanup before return. */
export async function settleLaunch({tmuxName,runId,launchConfig,sessionGroup,root,script,tmux={},
  startedAt = performance.now(), preflightMs = 0}) {
  const deadline = startedAt + LAUNCH_TIMEOUT_MS;
  const timing = { preflight_ms: preflightMs, new_session_ms: 0, executor_init_ms: 0, exec_confirm_ms: 0,
    cleanup_ms: 0, total_ms: 0, timeout_ms: LAUNCH_TIMEOUT_MS, last_phase: 'new_session' };
  let phase = 'new_session', phaseStartedAt = performance.now(), cleanupStartedAt, failure;
  const finishPhase = () => { timing[`${phase}_ms`] += performance.now() - phaseStartedAt; };
  const enterPhase = next => { finishPhase(); phase = next; phaseStartedAt = performance.now(); };
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
    enterPhase('executor_init');
    recordPaneProcess({runId,launchConfig,sessionGroup,root,panePid:Number(match[4])});
    connection = await openTmuxConnection({...tmux,timeoutMs:remaining()});
    connection.bindTarget(target);
    const command = argv => connection.command(argv,{timeoutMs:remaining()});
    if (sessionGroup === null) await command([C.setEnvironment,'-r','-t',target.tmuxSessionId,'ZYLOS_SESSION_GROUP']);
    enterPhase('exec_confirm');
    let lastCommand;
    while (true) {
      const output = await command([C.displayMessage,'-p','-t',target.paneId, F.exec]);
      const observed = parseExecReceipt(output);
      if (!observed || observed[1] !== target.tmuxSessionId || observed[2] !== target.paneId || observed[3] !== '0') {
        throw adapterError('LAUNCH_FAILED','Runtime exited before exec confirmation');
      }
      const name = observed[4];
      const started = name && !startingCommands.has(name.replace(/^-/,'').split('/').at(-1));
      if (started && lastCommand === name) {
        finishPhase();
        timing.last_phase = phase;
        return {tmuxName,createdAt:target.createdAt,launchTiming:timing};
      }
      lastCommand = started ? name : undefined;
      await new Promise(resolve => setTimeout(resolve,Math.min(EXEC_POLL_MS,remaining())));
    }
  } catch (error) {
    finishPhase();
    timing.last_phase = phase;
    cleanupStartedAt = performance.now();
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
    failure = isTmuxDirectoryError(error) || error.code === 'NAME_CONFLICT' || error.code === 'LAUNCH_FAILED' ? error
      : /duplicate session/.test(error.message) ? adapterError('NAME_CONFLICT',error.message)
        : adapterError('LAUNCH_FAILED',error.message,error.cause);
    // Only numeric durations and a fixed phase name leave this layer. In
    // particular, script text, environment values and tmux output stay out.
    failure.launchTiming = timing;
    throw failure;
  } finally {
    cleanupStartedAt ??= performance.now();
    connection?.close();
    script.cleanup();
    timing.cleanup_ms = performance.now() - cleanupStartedAt;
    timing.total_ms = performance.now() - startedAt;
  }
}

export async function launchSession({runtime,sessionGroup,runId,launchConfig,sessionMode}, options = {}) {
  const impl = await getRuntime(runtime);
  await impl.launch.prepare(options);
  const startedAt = performance.now();
  const remaining = () => {
    const ms = Math.ceil(startedAt + LAUNCH_TIMEOUT_MS - performance.now());
    if (ms <= 0) throw adapterError('LAUNCH_FAILED','Launch confirmation timed out','timeout');
    return ms;
  };
  let connection, failure;
  try {
    const {tmuxNameForGroup} = options.paths || await import('../session-group-paths.js');
    const tmuxName = tmuxNameForGroup(sessionGroup ?? 'origin');
    try {
      connection = await openConnection({ ...options, tmux: { ...options.tmux, timeoutMs: remaining() } });
      // Every launch preflight command uses the shared remaining budget.
      // Other session operations keep their ordinary command defaults.
      const preflightConnection = {
        get binding() { return connection.binding; },
        bindTarget: target => connection.bindTarget(target),
        command: (argv, options) => connection.command(argv, { ...options, timeoutMs: remaining() }),
      };
      const target = await (await dependencies(options)).observeSessionTarget({tmuxName,connection:preflightConnection,readReady:async () => null});
      if (target.present) throw adapterError('NAME_CONFLICT');
    } catch (error) { if (error.code !== 'TMUX_NO_SERVER') throw error; }
    const env = options.env || process.env;
    const command = (options.runtimeExecutable || runtimeExecutable)(impl.id,env);
    const help = (impl.launch.helpProbe === 'always' || launchConfig?.mode === 'override') ? await (options.runtimeHelp || runtimeHelpAsync)(command,env,{ timeoutMs: remaining() }) : '';
    validateLaunchConfig(impl,launchConfig,help);
    if (!runId || !['single','multi'].includes(sessionMode) ||
        (sessionMode === 'single' ? sessionGroup !== null && sessionGroup !== 'origin' : !sessionGroup)) throw adapterError('LAUNCH_FAILED','Invalid launch arguments','error');
    const root = await fs.realpath(options.root || ZYLOS_DIR);
    const cleanEnv = launchEnvironment(root,env,{ runtimeEnv: impl.launch.env });
    let args = impl.launch.buildArgs(launchConfig, {root, help});
    const upgrade = discoverUpgradeContext(root);
    if (upgrade.blocked || (upgrade.active && !upgrade.controllerAlive && upgrade.prompt)) {
      // End variadic options before appending the positional prompt.
      if (impl.launch.promptPlacement === 'separator' && upgrade.prompt) args.push('--');
      args = applyUpgradePrompt(
        args,
        upgrade.prompt,
        impl.launch.promptPlacement === 'kick' ? args.length - 1 : undefined,
        { append: !upgrade.blocked }
      );
    }
    remaining();
    const script = writeSessionLaunchScript({command,args,env:cleanEnv,root,multi:sessionGroup !== null});
    return await settleLaunch({tmuxName,runId,launchConfig,sessionGroup,root,script,tmux:options.tmux,
      startedAt, preflightMs: performance.now() - startedAt });
  } catch (error) {
    failure = isTmuxDirectoryError(error) || ['NAME_CONFLICT','RUNTIME_NOT_INSTALLED','MODEL_CONFIG_REJECTED','LAUNCH_FAILED'].includes(error.code)
      ? error : adapterError('LAUNCH_FAILED','Launch preflight failed',error.cause);
    failure.launchTiming ??= { preflight_ms: 0, new_session_ms: 0, executor_init_ms: 0, exec_confirm_ms: 0,
      cleanup_ms: 0, total_ms: 0, timeout_ms: LAUNCH_TIMEOUT_MS, last_phase: 'preflight' };
    throw failure;
  } finally {
    connection?.close();
    if (failure?.launchTiming.last_phase === 'preflight') {
      failure.launchTiming.preflight_ms = performance.now() - startedAt;
      failure.launchTiming.total_ms = failure.launchTiming.preflight_ms;
    }
  }
}
