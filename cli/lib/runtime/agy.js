import { SessionAdapter } from './session-adapter.js';
import { buildInstructionFile } from './instruction-builder.js';
import { adapterError, launchEnvironment } from './session-command.js';
import { ZYLOS_DIR } from '../config.js';

/** Antigravity is supported only with a Gemini API key, never account login. */
export class AgyAdapter extends SessionAdapter {
  get displayName() { return 'Antigravity'; }
  get runtimeId() { return 'agy'; }

  async buildInstructionFile() { return buildInstructionFile('agy'); }

  async launch(input) {
    const env = launchEnvironment(this.options.root || ZYLOS_DIR, this.options.env || process.env, { runtime: 'agy' });
    if (!env.GEMINI_API_KEY) throw adapterError('LAUNCH_FAILED', 'Antigravity requires GEMINI_API_KEY; account login is not supported');
    buildInstructionFile('agy', { zylosDir: this.options.root || ZYLOS_DIR });
    return super.launch(input);
  }

  // Unbracketed multiline paste submits the first line separately in agy.
  async sendText(input) { return super.sendText({ ...input, bracketedPaste: true }); }

  async checkAuth() {
    let env;
    try { env = launchEnvironment(this.options.root || ZYLOS_DIR, this.options.env || process.env, { runtime: 'agy' }); }
    catch { return { status: 'uncertain', reason: 'environment_unreadable' }; }
    const key = env.GEMINI_API_KEY;
    if (!key) return { status: 'failure', reason: 'api_key_missing' };
    try {
      // Keep the credential out of URLs, subprocess argv and returned errors.
      const response = await (this.options.fetch || fetch)('https://generativelanguage.googleapis.com/v1beta/models', {
        method: 'GET', headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      try { await response.body?.cancel(); } catch { /* Status is enough; no response text is exposed. */ }
      if (response.status === 200) return { status: 'success', reason: 'http_probe_200' };
      if ([400, 401, 403].includes(response.status)) return { status: 'failure', reason: `http_probe_${response.status}` };
      return { status: 'uncertain', reason: `http_probe_uncertain_${response.status}` };
    } catch {
      return { status: 'uncertain', reason: 'http_probe_network_error' };
    }
  }
}
