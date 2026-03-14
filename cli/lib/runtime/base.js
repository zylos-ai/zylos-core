/**
 * RuntimeAdapter — abstract base class for AI agent runtimes.
 *
 * All runtime implementations must extend this class and implement
 * all abstract methods. Optional methods have default no-op implementations.
 *
 * Supported runtimes (Phase 2+):
 *   - ClaudeAdapter  (cli/lib/runtime/claude.js)
 *   - CodexAdapter   (cli/lib/runtime/codex.js, Phase 4)
 */

export class RuntimeAdapter {
  /**
   * @param {object} config - Zylos config object (from getZylosConfig())
   */
  constructor(config = {}) {
    if (new.target === RuntimeAdapter) {
      throw new Error('RuntimeAdapter is abstract — instantiate a concrete subclass');
    }
    this.config = config;
  }

  /**
   * Build (or rebuild) the runtime's instruction file.
   * Must be called before launch() to ensure the instruction file is current.
   *
   * @returns {Promise<string>} Path to the generated file
   */
  async buildInstructionFile() {
    _abstract('buildInstructionFile');
  }

  /**
   * Start the runtime agent in a tmux session.
   * Calls buildInstructionFile() internally before launching.
   *
   * @returns {Promise<void>}
   */
  async launch() {
    _abstract('launch');
  }

  /**
   * Stop the runtime (kill the tmux session).
   * Implementations MUST be synchronous — HeartbeatEngine calls this without await.
   */
  stop() {
    _abstract('stop');
  }

  /**
   * Check if the runtime process is alive in tmux.
   *
   * @returns {Promise<boolean>}
   */
  async isRunning() {
    _abstract('isRunning');
  }

  /**
   * Deliver a message to the running agent via tmux stdin injection.
   *
   * @param {string} text
   * @returns {Promise<void>}
   */
  async sendMessage(text) {
    _abstract('sendMessage');
  }

  /**
   * Check authentication status for this runtime.
   *
   * @returns {Promise<{ok: boolean, reason: string}>}
   */
  async checkAuth() {
    _abstract('checkAuth');
  }

  /**
   * Returns the deps object expected by HeartbeatEngine for liveness probing.
   * Implemented in Phase 5.
   *
   * @returns {object|null}
   */
  getHeartbeatDeps() {
    return null;
  }

  /**
   * Returns a ContextMonitor instance for this runtime.
   * Implemented in Phase 5.
   *
   * @returns {object|null}
   */
  getContextMonitor() {
    return null;
  }

  /**
   * Human-readable runtime name (e.g. 'Claude Code', 'Codex').
   * Subclasses should override this.
   *
   * @returns {string}
   */
  get displayName() {
    return this.constructor.name;
  }

  /**
   * Stable machine-readable runtime identifier (e.g. 'claude', 'codex').
   * Used for equality checks — prefer this over displayName comparisons.
   * Subclasses should override this.
   *
   * @returns {string}
   */
  get runtimeId() {
    return this.constructor.name.toLowerCase();
  }

  /**
   * Name of the tmux session used by this runtime (e.g. 'claude-main', 'codex-main').
   * Used by activity-monitor.js for tmux helpers. Subclasses MUST override this.
   *
   * @returns {string}
   */
  get sessionName() {
    _abstract('sessionName');
  }
}

function _abstract(name) {
  throw new Error(`RuntimeAdapter: '${name}' must be implemented by subclass`);
}
