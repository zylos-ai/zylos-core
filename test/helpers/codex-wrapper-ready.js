import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readProcessInfo } from '../../skills/activity-monitor/scripts/claude-pid.js';

const processInfoUrl = new URL('../../skills/activity-monitor/scripts/claude-pid.js', import.meta.url).href;

// Stand in for the Codex launcher and its native child with two real processes.
const publisher = `
  import fs from 'node:fs';
  import { readProcessStart } from ${JSON.stringify(processInfoUrl)};
  const [file, runId] = process.argv.slice(1);
  fs.writeFileSync(file + '.tmp', JSON.stringify({
    runId, sessionId: 'codex-native-session', ts: Date.now(), startupControlIds: [],
    runtimePid: process.pid, runtimeStart: readProcessStart(process.pid),
    runtimeParentPid: process.ppid, runtimeParentStart: readProcessStart(process.ppid),
  }));
  fs.renameSync(file + '.tmp', file);
  setInterval(() => {}, 60000);
`;
const wrapper = `
  import { spawn } from 'node:child_process';
  spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(publisher)}, '--', ...process.argv.slice(1)],
    { stdio: 'inherit' }).on('exit', code => process.exit(code ?? 1));
`;

export async function startCodexWrapper({ tmux, tmuxName, runId, readyFile }) {
  await fs.mkdir(path.dirname(readyFile), { recursive: true });
  tmux('new-session', '-d', '-s', tmuxName, '-e', `ZYLOS_RUN_ID=${runId}`,
    '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"codex","mode":"default"}',
    process.execPath, '--input-type=module', '-e', wrapper, '--', readyFile, runId);
  const panePid = Number(tmux('display-message', '-p', '-t', `=${tmuxName}:`, '#{pane_pid}'));

  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    let ready;
    try { ready = JSON.parse(await fs.readFile(readyFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(20);
      continue;
    }
    const child = readProcessInfo(ready.runtimePid);
    assert.equal(child?.ppid, panePid);
    assert.notEqual(ready.runtimePid, panePid);
    assert.equal(ready.runtimeParentPid, panePid);
    assert.ok(ready.runtimeParentStart);
    return ready;
  }
  assert.fail('The Codex launcher fixture did not publish its child READY');
}
