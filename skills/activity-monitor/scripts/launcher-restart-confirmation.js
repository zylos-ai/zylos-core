import { execFile } from 'node:child_process';

function pm2(args, timeoutMs) {
  return new Promise((resolve, reject) => execFile('pm2', args, { timeout: Math.max(1, timeoutMs), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

/** Confirm a launcher restart without taking ownership of transition or fence writes. */
export class LauncherRestartConfirmation {
  constructor({ processName = 'c4-dispatcher', now = Date.now, timeoutMs = 30000,
    restart = ({ name, timeoutMs }) => pm2(['restart', name], timeoutMs),
    list = async ({ timeoutMs }) => JSON.parse(await pm2(['jlist'], timeoutMs)),
    diagnostic = () => {} } = {}) {
    Object.assign(this, { processName, now, timeoutMs, restart, list, diagnostic });
    this.attempt = null;
  }
  fail(attempt) {
    if (this.attempt === attempt) this.attempt = null;
    try { this.diagnostic({ event: 'transition_launcher_restart_failed', run_id: attempt.runId, reason: 'launcher_restart_unconfirmed' }); } catch {}
    return { confirmed: false, pending: false, reason: 'launcher_restart_unconfirmed' };
  }
  async advance({ runId, writtenAt }) {
    if (typeof runId !== 'string' || !runId || !Number.isSafeInteger(writtenAt)) throw new TypeError('A transition and its config write time are required');
    let attempt = this.attempt;
    if (attempt && (attempt.runId !== runId || attempt.writtenAt !== writtenAt)) throw new Error('Another launcher restart confirmation is still active');
    if (!attempt) {
      attempt = { runId, writtenAt, deadline: this.now() + this.timeoutMs, state: 'restarting', querying: false };
      this.attempt = attempt;
      Promise.resolve().then(() => this.restart({ name: this.processName, timeoutMs: this.timeoutMs }))
        .then(() => { attempt.state = 'restarted'; }, () => { attempt.state = 'failed'; });
      return { confirmed: false, pending: true };
    }
    if (attempt.state === 'failed' || this.now() >= attempt.deadline) return this.fail(attempt);
    if (attempt.state !== 'restarted' || attempt.querying) return { confirmed: false, pending: true };
    attempt.querying = true;
    try {
      const rows = await this.list({ timeoutMs: Math.max(1, attempt.deadline - this.now()) });
      if (this.now() >= attempt.deadline) return this.fail(attempt);
      if (!Array.isArray(rows)) return this.fail(attempt);
      const confirmed = rows.some(row => row.name === this.processName && row.pm2_env?.status === 'online'
        && Number.isFinite(row.pm2_env.pm_uptime) && row.pm2_env.pm_uptime > writtenAt);
      if (confirmed) { this.attempt = null; return { confirmed: true, pending: false }; }
      return { confirmed: false, pending: true };
    } catch { return this.fail(attempt); }
    finally { attempt.querying = false; }
  }
}
