import http from 'node:http';
import https from 'node:https';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export function isPrintableAsciiCredential(value) {
  return typeof value === 'string' && value.length > 0 && /^[\x20-\x7e]+$/.test(value);
}

export function isOfficialClaudeBaseUrl(baseUrl) {
  try { return new URL(baseUrl || ANTHROPIC_BASE_URL).hostname === 'api.anthropic.com'; }
  catch { return false; }
}

export function isOfficialClaudeVerificationBaseUrl(baseUrl = ANTHROPIC_BASE_URL) {
  try { return new URL(baseUrl).origin === ANTHROPIC_BASE_URL; }
  catch { return false; }
}

function apiUrl(baseUrl, endpoint) {
  const base = new URL(baseUrl);
  if (/[\x00-\x1f\x7f?#]/.test(baseUrl) || !['http:', 'https:'].includes(base.protocol) || !base.host
    || base.username || base.password || base.search || base.hash) throw new Error('Invalid API base URL');
  // Match the runtimes' base URL joining: retain the supplied path prefix.
  return new URL(baseUrl + (baseUrl.endsWith('/') && endpoint.startsWith('/') ? endpoint.slice(1) : endpoint));
}

export function classifyApiVerification(status, { officialAnthropic = false } = {}) {
  if (status === 401 || status === 403) return false;
  if (status >= 200 && status < 300 || officialAnthropic && status === 400) return true;
  return null;
}

/** Headers are checked without reading a response body, following redirects, or logging credentials. */
function verifyRequest(url, { credential, bearer, method, officialAnthropic = false, timeoutMs = 10000 }) {
  return new Promise(resolve => {
    let request, timer, settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      request = (url.protocol === 'https:' ? https : http).request(url, {
        method,
        headers: {
          ...(bearer ? { Authorization: `Bearer ${credential}` } : { 'x-api-key': credential }),
          ...(method === 'POST' ? { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } : {}),
        },
      }, response => {
        const status = response.statusCode;
        response.destroy();
        finish(classifyApiVerification(status, { officialAnthropic }));
      });
      request.on('error', () => finish(null));
      timer = setTimeout(() => { finish(null); request.destroy(); }, timeoutMs);
      if (method === 'POST') request.write('{}');
      request.end();
    } catch {
      finish(null);
      request?.destroy();
    }
  });
}

/** true = accepted, false = rejected credential, null = inconclusive or unreachable. */
export function verifyApiKey(credential, { baseUrl = ANTHROPIC_BASE_URL, authToken = false, timeoutMs } = {}) {
  if (!isPrintableAsciiCredential(credential)) return Promise.resolve(false);
  try {
    return verifyRequest(apiUrl(baseUrl, '/v1/messages'), {
      credential, bearer: authToken, method: 'POST', officialAnthropic: isOfficialClaudeVerificationBaseUrl(baseUrl), timeoutMs,
    });
  } catch { return Promise.resolve(null); }
}

/** Codex API bases include their API version; append only the models endpoint. */
export function verifyCodexApiKey(credential, { baseUrl = OPENAI_BASE_URL, timeoutMs } = {}) {
  if (!isPrintableAsciiCredential(credential)) return Promise.resolve(false);
  try { return verifyRequest(apiUrl(baseUrl, '/models'), { credential, bearer: true, method: 'GET', timeoutMs }); }
  catch { return Promise.resolve(null); }
}
