import { groupFromTmuxName } from '../session-group-paths.js';
import { readReadyIdentity, readTargetRuntime, readProcessTree } from './session-target.js';
import { parseTargetObservation, tmuxError, unavailableCommand } from './tmux-protocol.js';

const environmentKeys = ['ZYLOS_RUN_ID', 'ZYLOS_MODEL_CONFIG', 'ZYLOS_SESSION_GROUP'];
// Escape the marker, backslash and dollar before tmux's print layer. In 3.4
// that layer inserts escapes before named dollars and control bytes. No literal
// backslash remains, so its control escapes can be decoded without ambiguity.
const encode = key => `#{s|[$]|@d|:#{s|[\\\\]|@b|:#{s|@|@@|:${key}}}}`;
const field = key => `#{n:${encode(key)}}:${encode(key)}`;
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
  let output;
  try { output = await connection.command(['list-panes', '-a', '-F', batchObservationFormat]); }
  catch (error) { if (error.code === 'TMUX_NO_SERVER') return new Map(); throw unavailableCommand(error); }
  let tree;
  const sharedTree = () => tree ??= getTree();
  return new Map(await Promise.all(parseBatchObservations(output).map(async row => {
    const { sessionGroup, tmuxName, generation, tmuxSessionId, paneId, panePid, created, rawF2 } = row;
    const runId = rawF2.ZYLOS_RUN_ID || null;
    const runtime = await readTargetRuntime({ connection, paneId, panePid, rawF2, readProcessTree: sharedTree });
    const f3 = await readReady(sessionGroup === 'origin' && !rawF2.ZYLOS_SESSION_GROUP ? null : sessionGroup);
    const ready = Boolean(runId && f3?.runId === runId && typeof f3.sessionId === 'string' && f3.sessionId &&
      Number.isInteger(f3.ts) && Array.isArray(f3.startupControlIds) && f3.startupControlIds.every(Number.isInteger));
    return [sessionGroup, { present:true, tmuxName, runId, createdAt:Number(created), ...runtime, panePid,
      processRunning:true, runtimePid:panePid, ready, sessionId:ready ? f3.sessionId : null,
      runtimeSessionId:ready ? f3.sessionId : null, rawF2, f3:ready ? f3 : null,
      tmuxSessionId, paneId, serverGeneration:generation }];
  })));
}
