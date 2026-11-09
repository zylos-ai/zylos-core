import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmuxNameForGroup, groupRunDir } from '../../cli/lib/session-group-paths.js';

export function runtimeTools(env) {
  const socket = env.GROUP_DELETION_TEST_SOCKET;
  if (!socket || !socket.startsWith(path.dirname(env.HOME) + path.sep)) throw new Error('Private tmux socket required');
  const tmux = args => execFileSync('tmux', ['-S', socket, ...args], { env, encoding: 'utf8', timeout: 5000 }).trim();
  function startRuntime(group, { runId = randomUUID(), sessionId = randomUUID() } = {}) {
    const directory = groupRunDir(group, env);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'current-session.json'), JSON.stringify({ runId, sessionId,
      ts: Math.floor(Date.now() / 1000), startupControlIds: [] }));
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', tmuxNameForGroup(group),
      '-e', `ZYLOS_SESSION_GROUP=${group}`, '-e', `ZYLOS_RUN_ID=${runId}`,
      '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',
      '-e', `GROUP_DELETION_RECEIPTS=${path.join(env.ZYLOS_DIR, 'runtime-input.txt')}`,
      path.join(env.ZYLOS_DIR, 'claude')]);
    return { runId, sessionId };
  }
  const runtimePresent = group => {
    try { tmux(['has-session', '-t', `=${tmuxNameForGroup(group)}`]); return true; } catch { return false; }
  };
  return { tmux, startRuntime, runtimePresent };
}
