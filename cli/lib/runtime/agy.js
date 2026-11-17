import { SessionAdapter } from './session-adapter.js';
import { buildInstructionFile } from './instruction-builder.js';
import { adapterError, launchEnvironment } from './session-command.js';
import { ZYLOS_DIR } from '../config.js';
import { syncAgyConfig } from '../agy-setup.js';
import { execFile } from 'node:child_process';

const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** curl uses the same proxy environment as agy; the key is supplied only on stdin. */
export function requestAgyModels({ env, key, execute = execFile }) {
  if (/[\r\n]/.test(key)) return Promise.reject(new Error('Invalid API key header'));
  return new Promise((resolve, reject) => {
    // Disable curlrc and redirects: neither may send the credential elsewhere.
    const args = ['-q', '--silent', '--output', '/dev/null', '--write-out', '%{http_code}',
      '--proto', '=https', '--max-time', '10', '--header', '@-', '--url', MODELS_URL];
    const child = execute('curl', args, {
      env: env.HTTPS_PROXY ? { ...env, https_proxy: env.HTTPS_PROXY } : env, encoding: 'utf8', timeout: 11_000, killSignal: 'SIGKILL', maxBuffer: 1024,
    }, (error, stdout) => {
      if (error) reject(new Error('API probe connection failed'));
      else resolve(/^\d{3}$/.test(stdout.trim()) ? Number(stdout.trim()) : 0);
    });
    child.stdin.on('error', () => {}); // Early curl exit is handled by its callback.
    child.stdin.end(`x-goog-api-key: ${key}\n`);
  });
}

/** Antigravity is supported only with a Gemini API key, never account login. */
export class AgyAdapter extends SessionAdapter {
  get displayName() { return 'Antigravity'; }
  get runtimeId() { return 'agy'; }

  async buildInstructionFile() { return buildInstructionFile('agy'); }

  async launch(input) {
    const root = this.options.root || ZYLOS_DIR;
    const env = launchEnvironment(root, this.options.env || process.env, { runtime: 'agy' });
    if (!env.GEMINI_API_KEY) throw adapterError('LAUNCH_FAILED', 'Antigravity requires GEMINI_API_KEY; account login is not supported');
    syncAgyConfig({ zylosDir: root, home: env.HOME });
    buildInstructionFile('agy', { zylosDir: root });
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
      const status = await requestAgyModels({ env, key, execute: this.options.execFile || execFile });
      if (status === 200) return { status: 'success', reason: 'http_probe_200' };
      if ([400, 401, 403].includes(status)) return { status: 'failure', reason: `http_probe_${status}` };
      return { status: 'uncertain', reason: `http_probe_uncertain_${status}` };
    } catch {
      return { status: 'uncertain', reason: 'http_probe_network_error' };
    }
  }
}
