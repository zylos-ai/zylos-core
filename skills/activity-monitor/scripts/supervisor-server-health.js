/** Where alerts go when the owner has set no other destination: the pinned Origin conversation in Dashboard. */
export const DEFAULT_ALERT_DESTINATION = Object.freeze({ channel: 'dashboard', endpoint: 'origin' });

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
  /** Sends to the owner's `channel:endpoint` when set; `default`, unset, invalid or a failed send uses the pinned
   * Origin conversation in Dashboard, once. */
  async notify(message) {
    let target;
    try { target = await this.readAlertTarget(); } catch { target = null; }
    const valid = target && typeof target.channel === 'string' && target.channel && typeof target.endpoint === 'string' && target.endpoint;
    if (valid) {
      try { if (await this.sendAlert(target, message) !== false) return; } catch (error) { this.log(error); }
      if (target.channel === DEFAULT_ALERT_DESTINATION.channel && target.endpoint === DEFAULT_ALERT_DESTINATION.endpoint) return;
    }
    try { await this.sendAlert({ ...DEFAULT_ALERT_DESTINATION }, message); } catch (error) { this.log(error); }
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
