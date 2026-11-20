import fs from 'node:fs/promises';
import { getRuntime } from './index.js';
import { connection as openConnection, dependencies } from './session-ops.js';
import { adapterError, runtimeExecutable, runtimeHelpAsync, validateLaunchConfig, buildRuntimeArgs, launchEnvironment, writeSessionLaunchScript } from './session-command.js';
import { settleLaunch, LAUNCH_TIMEOUT_MS } from './session-launch.js';
import { applyUpgradePrompt, discoverUpgradeContext } from './upgrade-context.js';
import { ZYLOS_DIR } from '../config.js';
import { isTmuxDirectoryError } from './tmux-client-args.js';

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
    const command = (options.runtimeExecutable || runtimeExecutable)(runtime,env);
    const help = (runtime === 'codex' || launchConfig?.mode === 'override') ? await (options.runtimeHelp || runtimeHelpAsync)(command,env,{ timeoutMs: remaining() }) : '';
    validateLaunchConfig(runtime,launchConfig,help);
    if (!runId || !['single','multi'].includes(sessionMode) ||
        (sessionMode === 'single' ? sessionGroup !== null && sessionGroup !== 'origin' : !sessionGroup)) throw adapterError('LAUNCH_FAILED','Invalid launch arguments','error');
    const root = await fs.realpath(options.root || ZYLOS_DIR);
    const cleanEnv = launchEnvironment(root,env,{runtime:runtime});
    let args = buildRuntimeArgs(runtime, launchConfig, {root, help});
    const upgrade = discoverUpgradeContext(root);
    if (upgrade.blocked || (upgrade.active && !upgrade.controllerAlive && upgrade.prompt)) {
      // Claude's variadic --mcp-config must end before the positional prompt.
      if (runtime === 'claude' && upgrade.prompt) args.push('--');
      args = applyUpgradePrompt(
        args,
        upgrade.prompt,
        ['codex', 'agy'].includes(runtime) ? args.length - 1 : undefined,
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
