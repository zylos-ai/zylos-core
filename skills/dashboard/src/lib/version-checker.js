import https from 'node:https';
import { loadCoreModule } from './core-modules.js';

const { UNSUPPORTED } = await loadCoreModule('runtime/contract.js');

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

function fetchLatestTag(repo) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'zylos-dashboard', Accept: 'application/vnd.github.v3+json' },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`GitHub API ${res.statusCode}`));
        try {
          const tag = JSON.parse(data).tag_name;
          resolve(tag ? tag.replace(/^v/, '') : null);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

export function fetchNpmLatest(pkg) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
      headers: { 'User-Agent': 'zylos-dashboard', Accept: 'application/json' },
      timeout: 15000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`npm registry ${res.statusCode}`));
        try {
          const version = JSON.parse(data).version;
          resolve(typeof version === 'string' && version ? version : null);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

export class VersionChecker {
  constructor({
    onUpdate,
    sources = {},
    fetchZylosLatest = () => fetchLatestTag('zylos-ai/zylos-core'),
    fetchGithub = fetchLatestTag,
    fetchNpm = fetchNpmLatest,
  } = {}) {
    this._latest = { zylos: null };
    this._checks = new Map([['zylos', fetchZylosLatest]]);
    this._unsupported = new Set();
    for (const [id, source] of Object.entries(sources)) {
      if (source === UNSUPPORTED || !['github', 'npm'].includes(source?.source)) {
        this._unsupported.add(id);
        continue;
      }
      this._latest[id] = null;
      this._checks.set(id, source.source === 'github' ? () => fetchGithub(source.repo) : () => fetchNpm(source.package));
    }
    this._onUpdate = onUpdate || null;
    this._timer = null;
  }

  async check() {
    const checks = [...this._checks];
    const results = await Promise.allSettled(checks.map(async ([, fetch]) => fetch()));
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value) {
        this._latest[checks[index][0]] = result.value;
      }
    }
    if (this._onUpdate) this._onUpdate(this._latest);
  }

  getLatest() {
    return { ...this._latest };
  }

  unsupportedIds() {
    return [...this._unsupported];
  }

  start() {
    this.check().catch(() => {});
    this._timer = setInterval(() => this.check().catch(() => {}), TWELVE_HOURS);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}
