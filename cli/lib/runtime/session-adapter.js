import { removeOwnedTree } from '../../../skills/comm-bridge/scripts/remove-owned-tree.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeAdapter } from './base.js';
import { adapterError, runtimeExecutable, runtimeHelpAsync, validateLaunchConfig, buildRuntimeArgs, launchEnvironment, writeSessionLaunchScript } from './session-command.js';
import { settleLaunch, LAUNCH_TIMEOUT_MS } from './session-launch.js';
import { applyUpgradePrompt, discoverUpgradeContext } from './upgrade-context.js';
import { ZYLOS_DIR } from '../config.js';
import { TMUX_COMMAND as C, TMUX_FORMAT as F, isIdentityError } from './tmux-protocol.js';
import { isTmuxDirectoryError } from './tmux-client-args.js';

export class SessionAdapter extends RuntimeAdapter {
  async dependencies() {
    if (this.options.dependencies) return this.options.dependencies;
    return { ...(await import('./tmux-connection.js')), ...(await import('./session-target.js')) };
  }
  async connection(options = {}) {
    const deps = await this.dependencies();
    return deps.openTmuxConnection({ ...this.options.tmux, ...options });
  }
  async serverGeneration(connection) { return (await this.dependencies()).serverGeneration(connection); }
  async isRunning({tmuxName}) {
    let connection;
    try {
      const deps = await this.dependencies();
      connection = await this.connection();
      const target = await deps.observeSessionTarget({tmuxName, connection, readReady: async () => null, readProcessTree:this.options.readProcessTree});
      if (!target.present) return {tmux:false, process:false};
      return {tmux:true, process:true};
    } catch (error) {
      if (isTmuxDirectoryError(error)) throw error;
      if (['TMUX_NO_SERVER','TARGET_GONE'].includes(error.code)) return {tmux:false, process:false};
      if (error.code === 'TMUX_UNAVAILABLE') throw error;
      throw adapterError('TMUX_UNAVAILABLE','Cannot inspect session',error.cause === 'timeout' ? 'timeout':'error');
    } finally { connection?.close(); }
  }
  async stop({tmuxName, expectedRunId}) {
    let connection;
    try {
      const deps = await this.dependencies();
      let target;
      try {
        connection = await this.connection();
        // Only tmux identity matters here. Runtime/process observation remains
        // available to isRunning/launch, but does not authorize a stop target.
        target = await deps.observeSessionTarget({tmuxName, connection,
          readReady:async () => null, readProcessTree:async () => []});
      } catch (error) {
        if (error.code === 'TMUX_NO_SERVER') return;
        throw error;
      }
      if (!target.present) return;
      if (target.runId !== expectedRunId) throw adapterError('RUNID_MISMATCH');
      try {
        await deps.revalidateSessionTarget({connection,target,kind:'session'});
        await connection.command([C.killSession,'-t',target.tmuxSessionId], {kind:'session'});
      } catch (error) {
        // Only session-level absence proves stop succeeded; observation above
        // uses pane guards and can lose a pane while its session survives.
        if (error.code === 'TARGET_GONE') return;
        throw error;
      }
      // A successful kill is not sufficient: confirm removal of the session,
      // even if its original pane vanished while other windows remained.
      try {
        await connection.command([C.displayMessage,'-p','-t',target.tmuxSessionId,F.sessionId], {kind:'session'});
      } catch (error) {
        if (error.code === 'TARGET_GONE') return;
        throw error;
      }
      throw adapterError('STOP_UNCONFIRMED','Original session removal is not confirmed');
    } catch (error) {
      if (isTmuxDirectoryError(error)) throw error;
      if (['RUNID_MISMATCH','STOP_UNCONFIRMED'].includes(error.code)) throw error;
      throw adapterError('STOP_UNCONFIRMED','Session termination could not be confirmed',error.cause);
    } finally { connection?.close(); }
  }
  async captureScreen({target,connection}) {
    await (await this.dependencies()).revalidateSessionTarget({target,connection});
    return connection.command([C.capturePane,'-p','-t',target.paneId]);
  }
  async sendKeys({target,connection,keys}) {
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key))) {
      throw new TypeError('Invalid tmux key name');
    }
    try {
      await (await this.dependencies()).revalidateSessionTarget({target,connection});
      return await connection.command([C.sendKeys,'-t',target.paneId,...keys]);
    }
    catch (error) {
      if (isIdentityError(error) || isTmuxDirectoryError(error)) throw error;
      throw adapterError('ENTER_UNVERIFIED','Key delivery could not be confirmed',error.cause);
    }
  }
  async sendText({target,connection,text,bracketedPaste = false}) {
    if (typeof text !== 'string' || text.includes('\0')) throw new TypeError('Invalid text');
    const temporaryRoot = await fs.realpath(os.tmpdir());
    const dir = await fs.mkdtemp(path.join(temporaryRoot,'zylos-paste-'));
    const file = path.join(dir,'text');
    const buffer = `zylos-${randomUUID()}`;
    try {
      await fs.writeFile(file,text,{mode:0o600});
      try {
        await (await this.dependencies()).revalidateSessionTarget({target,connection});
        await connection.commandBatch([
          [C.loadBuffer,'-b',buffer,file.replaceAll('#','##')],
          [C.pasteBuffer,...(bracketedPaste ? ['-p'] : []),'-d','-b',buffer,'-t',target.paneId],
        ]);
      } catch (error) {
        if (isIdentityError(error) || isTmuxDirectoryError(error)) throw error;
        throw adapterError('PASTE_FAILED','Text delivery could not be confirmed',error.cause);
      }
    } finally {
      // Unique buffer cleanup is independent of target identity and executor state.
      try { await connection.cleanupBuffer(buffer); } catch {}
      removeOwnedTree(temporaryRoot, dir);
    }
  }
  async launch({sessionGroup,runId,launchConfig,sessionMode}) {
    const startedAt = performance.now();
    const remaining = () => {
      const ms = Math.ceil(startedAt + LAUNCH_TIMEOUT_MS - performance.now());
      if (ms <= 0) throw adapterError('LAUNCH_FAILED','Launch confirmation timed out','timeout');
      return ms;
    };
    let connection, failure;
    try {
      const {tmuxNameForGroup} = this.options.paths || await import('../session-group-paths.js');
      const tmuxName = tmuxNameForGroup(sessionGroup ?? 'origin');
      try {
        connection = await this.connection({ timeoutMs: remaining() });
        // Every launch preflight command uses the shared remaining budget.
        // Other adapter operations keep their ordinary command defaults.
        const preflightConnection = {
          get binding() { return connection.binding; },
          bindTarget: target => connection.bindTarget(target),
          command: (argv, options) => connection.command(argv, { ...options, timeoutMs: remaining() }),
        };
        const target = await (await this.dependencies()).observeSessionTarget({tmuxName,connection:preflightConnection,readReady:async () => null});
        if (target.present) throw adapterError('NAME_CONFLICT');
      } catch (error) { if (error.code !== 'TMUX_NO_SERVER') throw error; }
      const env = this.options.env || process.env;
      const command = (this.options.runtimeExecutable || runtimeExecutable)(this.runtimeId,env);
      const help = (this.runtimeId === 'codex' || launchConfig?.mode === 'override') ? await (this.options.runtimeHelp || runtimeHelpAsync)(command,env,{ timeoutMs: remaining() }) : '';
      validateLaunchConfig(this.runtimeId,launchConfig,help);
      if (!runId || !['single','multi'].includes(sessionMode) ||
          (sessionMode === 'single' ? sessionGroup !== null && sessionGroup !== 'origin' : !sessionGroup)) throw adapterError('LAUNCH_FAILED','Invalid launch arguments','error');
      const root = await fs.realpath(this.options.root || ZYLOS_DIR);
      const cleanEnv = launchEnvironment(root,env,{runtime:this.runtimeId});
      let args = buildRuntimeArgs(this.runtimeId, launchConfig, {root, help});
      const upgrade = discoverUpgradeContext(root);
      if (upgrade.blocked || (upgrade.active && !upgrade.controllerAlive && upgrade.prompt)) {
        // Claude's variadic --mcp-config must end before the positional prompt.
        if (this.runtimeId === 'claude' && upgrade.prompt) args.push('--');
        args = applyUpgradePrompt(
          args,
          upgrade.prompt,
          ['codex', 'agy'].includes(this.runtimeId) ? args.length - 1 : undefined,
          { append: !upgrade.blocked }
        );
      }
      remaining();
      const script = writeSessionLaunchScript({command,args,env:cleanEnv,root,multi:sessionGroup !== null});
      return await settleLaunch({tmuxName,runId,launchConfig,sessionGroup,root,script,tmux:this.options.tmux,
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
}
