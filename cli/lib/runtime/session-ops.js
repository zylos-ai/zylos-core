import { removeOwnedTree } from '../../../skills/comm-bridge/scripts/remove-owned-tree.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRuntime } from './index.js';
import { adapterError } from './session-command.js';
import { TMUX_COMMAND as C, TMUX_FORMAT as F, isIdentityError } from './tmux-protocol.js';
import { isTmuxDirectoryError } from './tmux-client-args.js';

export async function dependencies(options = {}) {
  if (options.dependencies) return options.dependencies;
  return { ...(await import('./tmux-connection.js')), ...(await import('./session-target.js')) };
}

export async function connection(options = {}) {
  const deps = await dependencies(options);
  return deps.openTmuxConnection({ ...options.tmux });
}

export function createSessionOps(options = {}) {
  const openConnection = () => connection(options);
  async function isRunning({tmuxName}) {
    let connection;
    try {
      const deps = await dependencies(options);
      connection = await openConnection();
      const target = await deps.observeSessionTarget({tmuxName, connection, readReady: async () => null, readProcessTree:options.readProcessTree});
      if (!target.present) return {tmux:false, process:false};
      return {tmux:true, process:true};
    } catch (error) {
      if (isTmuxDirectoryError(error)) throw error;
      if (['TMUX_NO_SERVER','TARGET_GONE'].includes(error.code)) return {tmux:false, process:false};
      if (error.code === 'TMUX_UNAVAILABLE') throw error;
      throw adapterError('TMUX_UNAVAILABLE','Cannot inspect session',error.cause === 'timeout' ? 'timeout':'error');
    } finally { connection?.close(); }
  }

  async function stop({tmuxName, expectedRunId}) {
    let connection;
    try {
      const deps = await dependencies(options);
      let target;
      try {
        connection = await openConnection();
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

  async function captureScreen({target,connection}) {
    await (await dependencies(options)).revalidateSessionTarget({target,connection});
    return connection.command([C.capturePane,'-p','-t',target.paneId]);
  }

  async function sendKeys({target,connection,keys}) {
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key))) {
      throw new TypeError('Invalid tmux key name');
    }
    try {
      await (await dependencies(options)).revalidateSessionTarget({target,connection});
      return await connection.command([C.sendKeys,'-t',target.paneId,...keys]);
    }
    catch (error) {
      if (isIdentityError(error) || isTmuxDirectoryError(error)) throw error;
      throw adapterError('ENTER_UNVERIFIED','Key delivery could not be confirmed',error.cause);
    }
  }

  async function sendText({runtime,target,connection,text,bracketedPaste = false}) {
    const impl = await getRuntime(runtime);
    const bracketed = impl.input.bracketedPaste || bracketedPaste;
    if (typeof text !== 'string' || text.includes('\0')) throw new TypeError('Invalid text');
    const temporaryRoot = await fs.realpath(os.tmpdir());
    const dir = await fs.mkdtemp(path.join(temporaryRoot,'zylos-paste-'));
    const file = path.join(dir,'text');
    const buffer = `zylos-${randomUUID()}`;
    try {
      await fs.writeFile(file,text,{mode:0o600});
      try {
        await (await dependencies(options)).revalidateSessionTarget({target,connection});
        await connection.commandBatch([
          [C.loadBuffer,'-b',buffer,file.replaceAll('#','##')],
          [C.pasteBuffer,...(bracketed ? ['-p'] : []),'-d','-b',buffer,'-t',target.paneId],
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

  return { isRunning, stop, captureScreen, sendKeys, sendText };
}
