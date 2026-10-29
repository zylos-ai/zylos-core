import https from 'node:https';

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
    fetchZylosLatest = () => fetchLatestTag('zylos-ai/zylos-core'),
    fetchCcLatest = () => fetchLatestTag('anthropics/claude-code'),
    fetchCodexLatest = fetchNpmLatest,
  } = {}) {
    this._latest = { zylos: null, cc: null, codex: null };
    this._onUpdate = onUpdate || null;
    this._fetchZylosLatest = fetchZylosLatest;
    this._fetchCcLatest = fetchCcLatest;
    this._fetchCodexLatest = fetchCodexLatest;
    this._timer = null;
  }

  async check() {
    const results = await Promise.allSettled([
      this._fetchZylosLatest(),
      this._fetchCcLatest(),
      this._fetchCodexLatest('@openai/codex'),
    ]);
    if (results[0].status === 'fulfilled' && results[0].value) {
      this._latest.zylos = results[0].value;
    }
    if (results[1].status === 'fulfilled' && results[1].value) {
      this._latest.cc = results[1].value;
    }
    if (results[2].status === 'fulfilled' && results[2].value) {
      this._latest.codex = results[2].value;
    }
    if (this._onUpdate) this._onUpdate(this._latest);
  }

  getLatest() {
    return { ...this._latest };
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
