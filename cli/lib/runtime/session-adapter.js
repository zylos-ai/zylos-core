import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeAdapter } from './base.js';
import { adapterError, runtimeExecutable, runtimeHelp, validateLaunchConfig, buildRuntimeArgs, launchEnvironment, writeSessionLaunchScript, hasNativeClaudeAuth } from './session-command.js';
import { settleLaunch } from './session-launch.js';
import { ZYLOS_DIR } from '../config.js';

export class SessionAdapter extends RuntimeAdapter {
  async dependencies() {
    if (this.options.dependencies) return this.options.dependencies;
    return { ...(await import('./tmux-connection.js')), ...(await import('./session-target.js')) };
  }
  async connection() {
    const deps = await this.dependencies();
    return deps.openTmuxConnection(this.options.tmux || {});
  }
  async serverGeneration(connection) { return (await this.dependencies()).serverGeneration(connection); }
  async isRunning({tmuxName}) {
    let connection;
    try {
      const deps = await this.dependencies();
      connection = await this.connection();
      const target = await deps.observeSessionTarget({tmuxName, connection, readReady: async () => null});
      if (!target.present) return {tmux:false, process:false};
      // F2 is configuration evidence only; process liveness needs a process snapshot.
      const observed = await deps.readTargetRuntime({connection, paneId:target.paneId, rawF2:{}, readProcessTree:this.options.readProcessTree});
      if (observed.runtime === 'unknown' && observed.runtimeObservation !== 'absent') throw adapterError('TMUX_UNAVAILABLE','Runtime process liveness is unknown','error');
      return {tmux:true, process:observed.runtime === this.runtimeId};
    } catch (error) {
      if (['TMUX_NO_SERVER','TARGET_GONE','GENERATION_CHANGED'].includes(error.code)) return {tmux:false, process:false};
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
        await connection.command(['kill-session','-t',target.tmuxSessionId], {kind:'session'});
      } catch (error) {
        // Only session-level absence proves stop succeeded; observation above
        // uses pane guards and can lose a pane while its session survives.
        if (error.code === 'TARGET_GONE') return;
        throw error;
      }
      // A successful kill is not sufficient: confirm removal of the session,
      // even if its original pane vanished while other windows remained.
      try {
        await connection.command(['display-message','-p','-t',target.tmuxSessionId,'#{session_id}'], {kind:'session'});
      } catch (error) {
        if (error.code === 'TARGET_GONE') return;
        throw error;
      }
      throw adapterError('STOP_UNCONFIRMED','Original session removal is not confirmed');
    } catch (error) {
      if (['RUNID_MISMATCH','STOP_UNCONFIRMED'].includes(error.code)) throw error;
      throw adapterError('STOP_UNCONFIRMED','Session termination could not be confirmed',error.cause);
    } finally { connection?.close(); }
  }
  async captureScreen({target,connection}) {
    await (await this.dependencies()).revalidateSessionTarget({target,connection});
    return connection.command(['capture-pane','-p','-t',target.paneId]);
  }
  async sendKeys({target,connection,keys}) {
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key))) {
      throw new TypeError('Invalid tmux key name');
    }
    try {
      await (await this.dependencies()).revalidateSessionTarget({target,connection});
      return await connection.command(['send-keys','-t',target.paneId,...keys]);
    }
    catch (error) {
      if (['TARGET_GONE','GENERATION_CHANGED','RUNID_MISMATCH'].includes(error.code)) throw error;
      throw adapterError('ENTER_UNVERIFIED','Key delivery could not be confirmed',error.cause);
    }
  }
  async sendText({target,connection,text}) {
    if (typeof text !== 'string' || text.includes('\0')) throw new TypeError('Invalid text');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'zylos-paste-'));
    const file = path.join(dir,'text');
    const buffer = `zylos-${randomUUID()}`;
    try {
      await fs.writeFile(file,text,{mode:0o600});
      try {
        await (await this.dependencies()).revalidateSessionTarget({target,connection});
        await connection.commandBatch([
          ['load-buffer','-b',buffer,file.replaceAll('#','##')],
          ['paste-buffer','-d','-b',buffer,'-t',target.paneId],
        ]);
      } catch (error) {
        if (['TARGET_GONE','GENERATION_CHANGED','RUNID_MISMATCH'].includes(error.code)) throw error;
        throw adapterError('PASTE_FAILED','Text delivery could not be confirmed',error.cause);
      }
    } finally {
      // Unique buffer cleanup is independent of target identity and executor state.
      try { await connection.cleanupBuffer(buffer); } catch {}
      await fs.rm(dir,{recursive:true,force:true});
    }
  }
  async launch({sessionGroup,runId,launchConfig,sessionMode}) {
    const {tmuxNameForGroup} = this.options.paths || await import('../session-group-paths.js');
    const tmuxName = tmuxNameForGroup(sessionGroup ?? 'origin');
    let connection;
    try {
      try {
        connection = await this.connection();
        const target = await (await this.dependencies()).observeSessionTarget({tmuxName,connection,readReady:async () => null});
        if (target.present) throw adapterError('NAME_CONFLICT');
      } catch (error) { if (error.code !== 'TMUX_NO_SERVER') throw error; }
      const env = this.options.env || process.env;
      const command = (this.options.runtimeExecutable || runtimeExecutable)(this.runtimeId,env);
      const help = (this.runtimeId === 'codex' || launchConfig?.mode === 'override') ? (this.options.runtimeHelp || runtimeHelp)(command,env) : '';
      validateLaunchConfig(this.runtimeId,launchConfig,help);
      if (!runId || !['single','multi'].includes(sessionMode) || (sessionMode === 'single') !== (sessionGroup === null)) throw adapterError('MODEL_CONFIG_REJECTED');
      const root = await fs.realpath(this.options.root || ZYLOS_DIR);
      const cleanEnv = launchEnvironment(root,env);
      if (this.runtimeId === 'claude' && (Object.hasOwn(cleanEnv, 'ANTHROPIC_API_KEY') || Object.hasOwn(cleanEnv, 'CLAUDE_CODE_OAUTH_TOKEN')) && hasNativeClaudeAuth(command, cleanEnv)) {
        delete cleanEnv.ANTHROPIC_API_KEY;
        delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;
      }
      const args = buildRuntimeArgs(this.runtimeId, launchConfig, {root, help});
      const script = writeSessionLaunchScript({command,args,env:cleanEnv,root,multi:sessionMode === 'multi'});
      return await settleLaunch({tmuxName,runId,launchConfig,sessionGroup,root,script,tmux:this.options.tmux});
    } catch (error) {
      if (['NAME_CONFLICT','RUNTIME_NOT_INSTALLED','MODEL_CONFIG_REJECTED','LAUNCH_FAILED'].includes(error.code)) throw error;
      throw adapterError('LAUNCH_FAILED','Launch preflight failed',error.cause);
    } finally { connection?.close(); }
  }
}
