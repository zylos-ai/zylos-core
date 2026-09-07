/** GitHub transport. Custom routes check local credential consent at every hop. */
import fs from 'node:fs';
import { getUpstreamSnapshot } from './upstreams.js';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';

const OFFICIAL_ORIGINS = new Set([
  'https://api.github.com', 'https://raw.githubusercontent.com', 'https://github.com',
]);

export function canForwardGitHubToken(url, snapshot) {
  const target = new URL(url);
  return target.protocol === 'https:' && !target.username && !target.password
    && snapshot?.trust?.forwardGitHubToken === true
    && snapshot.trust.allowedHosts?.includes(target.host) === true;
}

function validateRedirect(url, allowHttp = false) {
  const target = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.username || target.password || (target.protocol !== 'https:'
      && !(allowHttp && target.protocol === 'http:' && local))) {
    throw new Error('Unsafe GitHub upstream redirect');
  }
  return target.href;
}

function* request(url, { token, headers = [], output, timeout = 10000, snapshot = getUpstreamSnapshot() } = {}) {
  const direct = OFFICIAL_ORIGINS.has(new URL(url).origin);
  const temp = direct ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-github-http-'));
  try {
    for (let hop = 0; hop <= 10; hop++) {
      if (!direct) url = validateRedirect(url, snapshot?.allowHttp);
      const sendToken = token && (direct || canForwardGitHubToken(url, snapshot));
      const lines = [...(sendToken ? [`Authorization: Bearer ${token}`] : []), ...headers];
      if (lines.some(line => /[\r\n]/.test(line))) throw new Error('Invalid GitHub request header');
      // Custom routes must retain manual redirect and credential control.
      const args = direct ? ['-fsSL'] : ['-q', '-fsS'];
      if (lines.length) args.push('-H', '@-');
      if (output) args.push('-o', output);
      const headerPath = temp && path.join(temp, 'headers');
      if (headerPath) args.push('-D', headerPath);
      args.push(url);
      const result = yield {
        args,
        options: {
          encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'],
          ...(lines.length ? { input: lines.join('\n') + '\n' } : {}),
        },
      };
      if (direct) return result;
      // curl can prepend proxy CONNECT/interim headers. Inspect the final block.
      const blocks = fs.readFileSync(headerPath, 'utf8').trim().split(/\r?\n\r?\n/);
      const block = blocks.at(-1);
      const status = Number(block.match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
      if (!status) throw new Error('Invalid GitHub upstream HTTP response');
      if (![301, 302, 303, 307, 308].includes(status)) return result;
      const location = block.match(/^location:\s*(.+)$/im)?.[1]?.trim();
      if (!location) throw new Error('GitHub upstream redirect has no Location');
      if (hop === 10) throw new Error('Too many GitHub upstream redirects');
      url = validateRedirect(new URL(location, url).href, snapshot?.allowHttp);
    }
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function githubRequestSync(url, options) {
  const operation = request(url, options);
  try {
    let step = operation.next();
    while (!step.done) {
      const { args, options: execOptions } = step.value;
      step = operation.next(execFileSync('curl', args, execOptions));
    }
    return step.value;
  } finally { operation.return(); }
}

export async function githubRequestAsync(url, options) {
  const operation = request(url, options);
  try {
    let step = operation.next();
    while (!step.done) {
      const { args, options: { input, ...execOptions } } = step.value;
      const stdout = await new Promise((resolve, reject) => {
        const child = execFile('curl', args, execOptions, (err, stdout, stderr) => {
          if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
          else resolve(stdout);
        });
        child.stdin.on('error', () => {}); // early curl exit is reported by callback
        child.stdin.end(input);
      });
      step = operation.next(stdout);
    }
    return step.value;
  } finally { operation.return(); }
}
