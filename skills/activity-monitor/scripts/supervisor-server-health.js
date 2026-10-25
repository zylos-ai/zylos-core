/** An unavailable tmux server is unknown, never evidence of process exit.
 * Alert periodically until tmux observations succeed; do not terminate it.
 */
export class SupervisorServerHealth {
  constructor({ now = Date.now, readAlertTarget = () => null, sendAlert,
    log = () => {} } = {}) {
    Object.assign(this, { now, readAlertTarget, sendAlert, log });
    this.episodes = new Map();
  }
  observeSuccess({ socketKey = 'default' } = {}) {
    this.episodes.delete(socketKey);
    return { status: 'observable' };
  }
  observeFailure({ socketKey = 'default', error }) {
    if (error?.code !== 'TMUX_UNAVAILABLE') throw error;
    if (!this.episodes.has(socketKey)) this.episodes.set(socketKey, { since: this.now(), lastAlert: null });
    return { status: 'unavailable' };
  }
  async notify(message) {
    let target;
    try { target = await this.readAlertTarget(); } catch { target = null; }
    const valid = target && typeof target.channel === 'string' && target.channel && typeof target.endpoint === 'string' && target.endpoint;
    if (valid) {
      try { if (await this.sendAlert(target, message) !== false) return; } catch (error) { this.log(error); }
    }
    if (valid && target.channel === 'web-console' && target.endpoint === 'console') return;
    try { await this.sendAlert({ channel: 'web-console', endpoint: 'console' }, message); } catch (error) { this.log(error); }
  }
  async advance({ socketKey = 'default' } = {}) {
    const episode = this.episodes.get(socketKey);
    if (!episode) return { status: 'observable' };
    const now = this.now();
    // First alert after 60 seconds, then at most once every thirty minutes.
    if (now - episode.since >= 60000 && (episode.lastAlert === null || now - episode.lastAlert >= 1800000)) {
      episode.lastAlert = now;
      await this.notify(`tmux observation has been unavailable for ${Math.floor((now - episode.since) / 1000)} seconds. Sessions remain unconfirmed.`);
    }
    return { status: 'unavailable' };
  }
}
