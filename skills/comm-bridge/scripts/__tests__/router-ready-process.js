// Test-only lifecycle for one runtime launched by the measurement adapter.
// Owns only the POSIX group it creates. No process discovery or host matching.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const CLEANUP_GRACE_MS = 500;
export const OWNED_EXIT_TIMEOUT_MS = 5000;
const groupExists = pid => {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
};
const signalGroup = (pid, signal) => {
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
};
async function waitGroup(pid, milliseconds) {
  const deadline = performance.now() + milliseconds;
  while (groupExists(pid) && performance.now() < deadline) await sleep(25);
  return !groupExists(pid);
}

export async function superviseRuntime(binary, args, receipt) {
  // Adapter capability discovery must still see the real binary's output.
  if (args.includes('--help') || args.includes('--version')) {
    const result = spawnSync(binary, args, { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
    return;
  }
  fs.mkdirSync(path.dirname(receipt), { recursive: true, mode: 0o700 });
  const state = { runId: process.env.ZYLOS_RUN_ID, state: 'starting', groupGone: false };
  const write = () => {
    const temporary = `${receipt}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, receipt);
  };
  let child, stopping;
  const stop = () => stopping ??= (async () => {
    try {
      if (child?.pid) {
        // A detached spawn establishes the sample-owned group. Keep this
        // supervisor alive until that group is absent, even after leader exit.
        state.stopStage = 'term'; signalGroup(child.pid, 'SIGTERM');
        state.stopStage = 'wait_term'; state.groupGone = await waitGroup(child.pid, 1500);
        if (!state.groupGone) {
          signalGroup(child.pid, 'SIGKILL');
          state.groupGone = await waitGroup(child.pid, 1500);
        }
      } else state.groupGone = true;
      state.state = state.groupGone ? 'stopped' : 'unconfirmed';
    } catch (error) { state.state = 'unconfirmed'; state.errorCode = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'OWNED_GROUP_STOP_FAILED'; }
    write();
    process.exitCode = state.groupGone ? 0 : 1;
  })();
  for (const signal of ['SIGHUP','SIGTERM','SIGINT']) process.once(signal, stop);
  write();
  child = spawn(binary, args, { detached: true, stdio: 'inherit' });
  child.once('error', () => { state.spawnFailed = true; void stop(); });
  child.once('exit', () => { void stop(); });
  state.state = 'running'; write();
  // Retain the supervisor (and its ownership of the newly created PGID) even
  // if the child leader exits before background writers in the same group.
  while (!stopping) await sleep(25);
  await stopping;
}

export async function waitOwnedRuntime(receipt, runId, timeoutMs = OWNED_EXIT_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  do {
    try {
      const state = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (state.runId === runId && ['stopped','unconfirmed'].includes(state.state)) {
        return { receiptReceived: true, groupGone: state.state === 'stopped' && state.groupGone === true,
          spawnFailed: state.spawnFailed === true, errorCode: state.errorCode ?? null, stopStage: state.stopStage ?? null };
      }
    } catch { /* Atomic receipt not yet published; never inspect host processes. */ }
    await sleep(25);
  } while (performance.now() < deadline);
  return { receiptReceived: false, groupGone: false };
}

export async function verifyHomeAbsent(home, graceMs = CLEANUP_GRACE_MS) {
  const absentImmediately = !fs.existsSync(home);
  await sleep(graceMs);
  const absentAfterGrace = !fs.existsSync(home);
  return { absentImmediately, absentAfterGrace, graceMs, homeRemoved: absentImmediately && absentAfterGrace };
}
