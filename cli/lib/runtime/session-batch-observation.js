import { groupFromTmuxName } from '../session-group-paths.js';
import { readReadyIdentity, readTargetRuntime, readProcessTree, paneReady } from './session-target.js';
import { parseTargetObservation, parseTmuxEnvironment, tmuxError, unavailableCommand, isMissingTarget, tmuxReadCommands, parseReadResponse } from './tmux-protocol.js';

const environmentKeys = ['ZYLOS_RUN_ID', 'ZYLOS_MODEL_CONFIG', 'ZYLOS_SESSION_GROUP'];
// Escape the marker, backslash and dollar before tmux's print layer. In 3.4
// that layer inserts escapes before named dollars and control bytes. No literal
// backslash remains, so its control escapes can be decoded without ambiguity.
const encode = key => `#{s|[$]|@d|:#{s|[\\\\]|@b|:#{s|@|@@|:${key}}}}`;
const field = key => `#{n:${encode(key)}}:${encode(key)}`;
// Format environment lookup falls back to the global environment when a session
// entry is absent. Read back colliding session entries explicitly below.
export const batchObservationFormat = [
  '#{pid}:#{start_time}', '#{session_id}', '#{pane_id}', '#{session_created}', '#{pane_pid}',
  '#{window_active}', '#{pane_active}', field('session_name'), ...environmentKeys.map(field),
].join('\t');

export function parseBatchObservations(output) {
  const control = { n:'\n', r:'\r', b:'\b', a:'\x07', v:'\v', f:'\f', t:'\t', s:' ' };
  const text = output.replace(/\\([0-7]{3}|[nrbavfts])/g, (whole, value) =>
    value.length === 3 ? String.fromCharCode(parseInt(value, 8)) : control[value] ?? whole);
  const bytes = Buffer.from(text);
  let offset = 0;
  const invalid = () => { throw tmuxError('TMUX_RESPONSE_INVALID', 'Invalid batch tmux observation'); };
  function token(separator) {
    const end = bytes.indexOf(separator, offset);
    if (end < 0) return invalid();
    const value = bytes.subarray(offset, end).toString(); offset = end + 1; return value;
  }
  function framed(separator) {
    const size = token(58);
    if (!/^\d+$/.test(size) || !Number.isSafeInteger(Number(size))) return invalid();
    const end = offset + Number(size);
    if (end > bytes.length) return invalid();
    const value = bytes.subarray(offset, end).toString(); offset = end;
    if (separator !== null) { if (bytes[offset++] !== separator) return invalid(); }
    return value.replace(/@(@|b|d)/g, (_, escaped) => ({ '@':'@', b:'\\', d:'$' })[escaped]);
  }
  const result = [];
  while (offset < bytes.length) {
    const identity = Array.from({ length:5 }, () => token(9));
    const windowActive = token(9), paneActive = token(9);
    if (!/^[01]$/.test(windowActive) || !/^[01]$/.test(paneActive)) return invalid();
    const tmuxName = framed(9);
    const values = environmentKeys.map((_, index) => framed(index === environmentKeys.length - 1 ? null : 9));
    if (offset < bytes.length && bytes[offset++] !== 10) return invalid();
    const sessionGroup = groupFromTmuxName(tmuxName);
    if (sessionGroup === null || windowActive !== '1' || paneActive !== '1') continue;
    result.push({ ...parseTargetObservation(identity.join('\t')), tmuxName, sessionGroup,
      rawF2: Object.fromEntries(environmentKeys.map((key, index) => [key, values[index]])) });
  }
  return result;
}

/** Read-only snapshot. It never binds targets or grants permission for actions. */
export async function observeSessionTargets({ connection, readReady = readReadyIdentity,
  readProcessTree: getTree = readProcessTree } = {}) {
  let rows;
  try {
    const marker = 'ZYLOS_BATCH_GLOBAL';
    const output = await connection.command(['list-panes', '-a', '-F', batchObservationFormat,
      ';', 'display-message', '-p', marker, ';', 'show-environment', '-gs']);
    const boundary = output.indexOf(`\n${marker}\n`);
    if (boundary < 0) throw tmuxError('TMUX_RESPONSE_INVALID', 'Missing batch environment boundary');
    rows = parseBatchObservations(output.slice(0, boundary));
    const global = parseTmuxEnvironment(output.slice(boundary + marker.length + 2));
    const collisions = rows.filter(row => environmentKeys.some(key => global[key] !== undefined && row.rawF2[key] === global[key]));
    if (collisions.length) {
      // Keep all collision reads in one client, checking each captured identity
      // before exposing any session's environment to callers.
      const binding = row => ({ serverGeneration:row.generation,
        tmuxSessionId:row.tmuxSessionId, paneId:row.paneId });
      const commands = collisions.flatMap((row, index) => [
        ['display-message', '-p', `ZYLOS_BATCH_SESSION_${index}`],
        tmuxReadCommands([['show-environment', '-s', '-t', row.tmuxSessionId]], binding(row)),
      ]);
      let text;
      try { text = await connection.command(commands.flatMap((argv, index) => index ? [';', ...argv] : argv)); }
      catch (error) {
        if (isMissingTarget(error) || error.code === 'TMUX_NO_SERVER') throw tmuxError('TARGET_GONE', 'Batch target disappeared during observation');
        throw error;
      }
      const sections = text.split(/^ZYLOS_BATCH_SESSION_(\d+)\n/gm);
      if (sections[0] !== '' || sections.length !== collisions.length * 2 + 1) throw tmuxError('TMUX_RESPONSE_INVALID', 'Missing batch session environment');
      collisions.forEach((row, index) => {
        if (sections[index * 2 + 1] !== String(index)) throw tmuxError('TMUX_RESPONSE_INVALID', 'Invalid batch session environment order');
        const section = sections[index * 2 + 2].replace(/\n$/, '');
        const local = parseTmuxEnvironment(parseReadResponse(section, null, binding(row)));
        row.rawF2 = Object.fromEntries(environmentKeys.map(key => [key, local[key] ?? '']));
      });
    }
  } catch (error) { if (error.code === 'TMUX_NO_SERVER') return new Map(); throw unavailableCommand(error); }
  let tree;
  const sharedTree = () => tree ??= getTree();
  return new Map(await Promise.all(rows.map(async row => {
    const { sessionGroup, tmuxName, generation, tmuxSessionId, paneId, panePid, created, rawF2 } = row;
    const runId = rawF2.ZYLOS_RUN_ID || null;
    const runtime = await readTargetRuntime({ connection, paneId, panePid, rawF2, readProcessTree: sharedTree });
    const f3 = paneReady(sessionGroup, await readReady(sessionGroup), { runId, runtime: runtime.runtime, panePid });
    const ready = Boolean(runId && f3?.runId === runId && typeof f3.sessionId === 'string' && f3.sessionId &&
      Number.isInteger(f3.ts) && Array.isArray(f3.startupControlIds) && f3.startupControlIds.every(Number.isInteger));
    return [sessionGroup, { present:true, tmuxName, runId, createdAt:Number(created), ...runtime, panePid,
      processRunning:true, runtimePid:panePid, ready, sessionId:ready ? f3.sessionId : null,
      runtimeSessionId:ready ? f3.sessionId : null, rawF2, f3:ready ? f3 : null,
      tmuxSessionId, paneId, serverGeneration:generation }];
  })));
}
