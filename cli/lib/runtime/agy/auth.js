import { createIdentity } from '../shared/identity.js';
import { writeEnvFile } from '../../env.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { env as runtimeEnv } from './launch.js';
import { launchEnvironment } from '../session-command.js';
import { ZYLOS_DIR } from '../../config.js';
import { credentialEnvValue, upsertEnvValue, warnUnrestrictedCredentialFiles } from '../../runtime-setup.js';
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
  try { env = launchEnvironment(options.root || ZYLOS_DIR, options.env || process.env, { runtimeEnv }); }
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

function credentialFiles() {
  return [path.join(ZYLOS_DIR, '.env')];
}

function saveCredential(kind, value, warnings) {
  if (kind !== 'apiKey' || !saveAgyApiKey(value)) return false;
  warnUnrestrictedCredentialFiles(credentialFiles(), warnings);
  return true;
}

/** Save the API-key-only Antigravity credential; keep it out of argv and native login files. */
export function saveAgyApiKey(apiKey) {
  const encoded = credentialEnvValue(apiKey);
  if (encoded === null) return false;
  try {
    const envPath = path.join(ZYLOS_DIR, '.env');
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    content = content.replace(/^[^\S\r\n]*(?:export[^\S\r\n]+)?GEMINI_API_KEY(?:[^\S\r\n]*=|:[^\S\r\n]+).*(?:\r?\n|$)/gm, '');
    writeEnvFile(envPath, upsertEnvValue(content, 'GEMINI_API_KEY', encoded, 'Gemini API key for Antigravity CLI'));
    process.env.GEMINI_API_KEY = apiKey;
    return true;
  } catch { return false; }
}

const { findExecutable } = createIdentity('agy');

async function initAuthenticate(opts, { reportError, deps = {} }) {
  const { findExecutable: findCli = findExecutable, agyAuth = checkAuth } = deps;
  let checked;
  try { checked = await agyAuth(); } catch { checked = { status: 'uncertain' }; }
  const authenticated = findCli() !== null && checked.status === 'success';
  if (!authenticated) reportError('Antigravity API key not confirmed. Run zylos runtime agy --save-apikey <key>.');
  return {
    authenticated, exitCode: authenticated ? 0 : 1, apiAttempted: false, pending: {},
    unauthenticatedBox: [
      'Antigravity requires a valid GEMINI_API_KEY            ',
      'zylos runtime agy --save-apikey <key>                  ',
    ],
  };
}

export const auth = Object.freeze({
  checkAuth,
  cliHelp: Object.freeze([
    '--save-apikey <key>             GEMINI_API_KEY (no personal subscription login)',
  ]),
  initAuthenticate,
  initOptionsFromEnv: UNSUPPORTED,
  initApplyBaseUrl: UNSUPPORTED,
  initPersist: UNSUPPORTED,
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
