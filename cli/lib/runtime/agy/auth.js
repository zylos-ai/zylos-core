import { execFile } from 'node:child_process';
import { launchEnvironment } from '../session-command.js';
import { ZYLOS_DIR } from '../../config.js';
import {
  credentialFiles as runtimeCredentialFiles, warnUnrestrictedCredentialFiles, saveAgyApiKey,
} from '../../runtime-setup.js';
import { UNSUPPORTED } from '../contract.js';

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

export async function checkAuth(options = {}) {
  let env;
  try { env = launchEnvironment(options.root || ZYLOS_DIR, options.env || process.env, { runtime: 'agy' }); }
  catch { return { status: 'uncertain', reason: 'environment_unreadable' }; }
  const key = env.GEMINI_API_KEY;
  if (!key) return { status: 'failure', reason: 'api_key_missing' };
  try {
    // Keep the credential out of URLs, subprocess argv and returned errors.
    const status = await requestAgyModels({ env, key, execute: options.execFile || execFile });
    if (status === 200) return { status: 'success', reason: 'http_probe_200' };
    if ([400, 401, 403].includes(status)) return { status: 'failure', reason: `http_probe_${status}` };
    return { status: 'uncertain', reason: `http_probe_uncertain_${status}` };
  } catch {
    return { status: 'uncertain', reason: 'http_probe_network_error' };
  }
}

const credentialFiles = () => runtimeCredentialFiles('agy');

function saveCredential(kind, value, warnings) {
  if (kind !== 'apiKey' || !saveAgyApiKey(value)) return false;
  warnUnrestrictedCredentialFiles(credentialFiles(), warnings);
  return true;
}

export const auth = Object.freeze({
  checkAuth,
  remedy: 'replace the API key with zylos runtime agy --save-apikey <key>',
  credentialFiles,
  credentialKinds: Object.freeze({ apiKey: '<key>' }),
  saveCredential,
  saveBaseUrl: UNSUPPORTED,
  baseUrlExample: UNSUPPORTED,
  nativeLogin: UNSUPPORTED,
  afterLogin: UNSUPPORTED,
  overrideWarnings: UNSUPPORTED,
});
