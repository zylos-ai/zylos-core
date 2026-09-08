/** Operation-scoped GitHub routing. Profile retrieval uses the existing curl dependency. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';

export const DIRECT_GITHUB = Object.freeze({
  apiBase: 'https://api.github.com/',
  rawBase: 'https://raw.githubusercontent.com/',
  downloadBase: 'https://github.com/',
});
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROFILE_BYTES = 1024 * 1024;
const operation = new AsyncLocalStorage();
const DEFAULT_TRUST = Object.freeze({ forwardGitHubToken: false, allowedHosts: Object.freeze([]) });
const DIRECT_SNAPSHOT = Object.freeze({ github: DIRECT_GITHUB, trust: DEFAULT_TRUST });

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}: expected object`);
}
function keys(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${label}: unsupported field`);
}
function safePath(value, label) {
  if (typeof value !== 'string' || !value || /[\\\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${label}`);
  for (const part of value.split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { throw new Error(`Invalid ${label}`); }
    if (decoded === '.' || decoded === '..' || /[\\/\x00-\x1f\x7f]/.test(decoded)) throw new Error(`Invalid ${label}: unsafe path`);
  }
  return value;
}
function secureUrl(value, { base = false, allowHttp = false } = {}) {
  if (typeof value !== 'string' || !value || /[\x00-\x20\x7f\\{}]/.test(value)) throw new Error('Invalid upstream URL');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid upstream URL'); }
  if (url.username || url.password || url.hash || (base && url.search)) throw new Error('Invalid upstream URL: credentials, fragment or base query');
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Upstream URLs require HTTPS (HTTP is restricted to explicit loopback tests)');
  }
  // Check the original pathname too: URL would otherwise silently remove dot segments.
  const rawPath = value.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0];
  if (rawPath) safePath(rawPath, 'upstream URL path');
  if (base && !url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export function validateProfile(value, { allowHttp = false } = {}) {
  keys(value, ['schemaVersion', 'revision', 'providers'], 'profile');
  if (value.schemaVersion !== 1) throw new Error('Unsupported upstream profile schemaVersion');
  if (typeof value.revision !== 'string' || !value.revision.trim() || value.revision.length > 200 || /[\x00-\x1f\x7f]/.test(value.revision)) throw new Error('Invalid upstream revision');
  return { schemaVersion: 1, revision: value.revision, providers: validateProviders(value.providers, allowHttp) };
}
function validateProviders(value, allowHttp) {
  keys(value, ['github'], 'providers');
  const result = {};
  if (value.github !== undefined) {
    keys(value.github, Object.keys(DIRECT_GITHUB), 'github provider');
    result.github = Object.fromEntries(Object.entries(value.github).map(([key, url]) => [key, secureUrl(url, { base: true, allowHttp })]));
  }
  return result;
}
function validateTrust(value = {}) {
  keys(value, ['forwardGitHubToken', 'allowedHosts'], 'local trust');
  if (value.forwardGitHubToken !== undefined && typeof value.forwardGitHubToken !== 'boolean') throw new Error('Invalid local token authorization');
  const hosts = value.allowedHosts ?? [];
  if (!Array.isArray(hosts) || hosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host) || host.startsWith('.') || host.includes('..'))) throw new Error('Invalid local allowedHosts');
  return { forwardGitHubToken: value.forwardGitHubToken ?? false, allowedHosts: hosts.map(host => host.toLowerCase()) };
}
function validateSource(value, allowHttp) {
  object(value, 'source');
  if (value.type === 'direct') { keys(value, ['type'], 'direct source'); return { type: 'direct' }; }
  if (value.type === 'remote') {
    keys(value, ['type', 'url'], 'remote source');
    return { type: 'remote', url: secureUrl(value.url, { allowHttp }) };
  }
  if (value.type === 'local') {
    keys(value, ['type', 'path'], 'local source');
    if (typeof value.path !== 'string' || !path.isAbsolute(value.path)) throw new Error('Local upstream config requires an absolute path');
    return { type: 'local', path: path.resolve(value.path) };
  }
  throw new Error('Invalid upstream source type');
}
function sourceFromValue(value) {
  if (typeof value !== 'string' || !value) throw new Error('Upstream source selection requires a value');
  if (value === 'direct') return { type: 'direct' };
  // URL-shaped inputs must pass URL validation; never reinterpret them as files.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return { type: 'remote', url: value };
  return { type: 'local', path: path.resolve(value) };
}
export function parseUpstreamArgs(args) {
  const remaining = [];
  let source;
  for (let i = 0; i < args.length; i++) {
    const equal = args[i].indexOf('=');
    const flag = equal < 0 ? args[i] : args[i].slice(0, equal);
    if (flag !== '--upstream-config') {
      if (flag.startsWith('--upstream-')) throw new Error(`Unknown upstream option: ${flag}; use --upstream-config <file|https-url|direct>`);
      remaining.push(args[i]); continue;
    }
    const value = equal < 0 ? args[++i] : args[i].slice(equal + 1);
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (source) throw new Error('--upstream-config may only be specified once');
    source = sourceFromValue(value);
  }
  return { args: remaining, source };
}
function readJson(file, optional = false) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (optional && err.code === 'ENOENT') return undefined; throw new Error(`Cannot read valid upstream ${path.basename(file)}`); }
}
function configPaths(zylosDir) {
  const dir = path.join(zylosDir, '.zylos');
  return { dir, settings: path.join(dir, 'upstreams.json'), cache: path.join(dir, 'upstreams-cache.json'), lock: path.join(dir, 'upstreams-cache.lock') };
}
function settingsValue(value, allowHttp) {
  if (value && Object.hasOwn(value, 'overrides')) throw new Error('Upstream settings overrides are not supported; select a local profile with --upstream-config instead');
  keys(value, ['schemaVersion', 'source', 'trust'], 'local settings');
  if (value.schemaVersion !== 1) throw new Error('Unsupported upstream settings schemaVersion');
  return {
    schemaVersion: 1,
    ...(value.source !== undefined ? { source: validateSource(value.source, allowHttp) } : {}),
    trust: validateTrust(value.trust),
  };
}
export function resolveSelection({ source, env = process.env, zylosDir = env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'), allowHttp = false } = {}) {
  for (const name of ['ZYLOS_UPSTREAM_PROFILE', 'ZYLOS_UPSTREAM_CONFIG_URL']) {
    if (env[name] !== undefined) throw new Error(`${name} has been removed; use ZYLOS_UPSTREAM_CONFIG instead`);
  }
  const files = configPaths(zylosDir);
  const savedValue = readJson(files.settings, true);
  const saved = savedValue === undefined ? undefined : settingsValue(savedValue, allowHttp);
  const envSource = !source && env.ZYLOS_UPSTREAM_CONFIG !== undefined ? sourceFromValue(env.ZYLOS_UPSTREAM_CONFIG) : undefined;
  const chosen = validateSource(source || envSource || saved?.source || { type: 'direct' }, allowHttp);
  const url = chosen.type === 'remote' ? chosen.url : undefined;
  return { source: chosen, url, files, allowHttp, settings: saved, explicit: Boolean(source || envSource), selectedBy: source ? 'cli' : envSource ? 'environment' : saved?.source ? 'saved' : 'default' };
}
function readCache(selection) {
  try {
    const cache = readJson(selection.files.cache, true);
    if (!cache || cache.schemaVersion !== 1 || cache.sourceUrl !== selection.url) return null;
    keys(cache, ['schemaVersion', 'sourceUrl', 'profile', 'etag', 'checkedAt'], 'cache');
    const profile = validateProfile(cache.profile, selection);
    if (typeof cache.checkedAt !== 'number' || !Number.isFinite(cache.checkedAt) || cache.checkedAt < 0 || cache.checkedAt > 8640000000000000 || (cache.etag !== undefined && (typeof cache.etag !== 'string' || /[\r\n]/.test(cache.etag)))) return null;
    return { ...cache, profile };
  } catch { return null; }
}
function fresh(cache, now, ttlMs) { return cache && cache.checkedAt <= now && now - cache.checkedAt < ttlMs; }
function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
function lockOwner(file) {
  try { return readJson(file); } catch { return null; }
}
function isDead(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
}
function unlinkOwner(file, nonce) {
  if (lockOwner(file)?.nonce === nonce) fs.unlinkSync(file);
}
function publishLock(file, owner) {
  // Fully initialize metadata before publishing: a crash cannot expose an empty lock.
  const tmp = `${file}.${owner.nonce}.owner`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    fs.linkSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
async function lockCache(selection, timeoutMs) {
  fs.mkdirSync(selection.files.dir, { recursive: true });
  const started = Date.now(), owner = { pid: process.pid, nonce: randomUUID() };
  while (true) {
    try {
      publishLock(selection.files.lock, owner);
      return () => { try { unlinkOwner(selection.files.lock, owner.nonce); } catch {} };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Recovery is serialized, and both files contain complete owner metadata.
      const recovery = `${selection.files.lock}.recovery`;
      const heldRecovery = lockOwner(recovery);
      if (isDead(heldRecovery)) { try { unlinkOwner(recovery, heldRecovery.nonce); } catch {} }
      let acquired = false;
      try {
        publishLock(recovery, owner);
        acquired = true;
        const held = lockOwner(selection.files.lock);
        if (isDead(held)) { unlinkOwner(selection.files.lock, held.nonce); continue; }
      } catch {} finally {
        if (acquired) { try { unlinkOwner(recovery, owner.nonce); } catch {} }
      }
      if (Date.now() - started >= timeoutMs) {
        throw Object.assign(new Error('Timed out waiting for upstream refresh lock'), {
          code: 'UPSTREAM_LOCK_TIMEOUT', lockPath: selection.files.lock,
        });
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
function profileConnectionError() {
  // Never attach curl stderr or spawn errors: they may contain URLs or proxy credentials.
  return Object.assign(new Error('Profile connection failed'), { code: 'UPSTREAM_PROFILE_CONNECTION' });
}
function curlProfileRequest(target, etag, selection, deadline) {
  return new Promise((resolve, reject) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) { reject(profileConnectionError()); return; }
    // -q must be first: local curlrc must not add credentials, redirects or output files.
    // CONNECT headers are suppressed so a proxy's 200 is not mistaken for the origin.
    const args = ['-q', '--silent', '--globoff', '--include', '--suppress-connect-headers',
      '--proto', selection.allowHttp ? '=https,http' : '=https',
      '--max-time', String(remainingMs / 1000)];
    if (etag) args.push('--header', `If-None-Match: ${etag}`);
    args.push('--url', target);
    let child;
    try { child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { reject(profileConnectionError()); return; }
    let pending = Buffer.alloc(0), headerBytes = 0, bodyBytes = 0;
    let response, failure, stopped = false;
    const chunks = [];
    const stop = error => {
      if (stopped) return;
      stopped = true;
      failure = error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(profileConnectionError()), remainingMs);
    child.on('error', () => { failure = profileConnectionError(); });
    child.stdout.on('error', () => stop(profileConnectionError()));
    child.stdout.on('data', chunk => {
      if (stopped) return;
      if (!response) {
        pending = Buffer.concat([pending, chunk]);
        while (!response) {
          const end = pending.indexOf('\r\n\r\n');
          if (end < 0) {
            if (headerBytes + pending.length > 64 * 1024) stop(new Error('Upstream profile headers exceed 64 KiB'));
            return;
          }
          headerBytes += end + 4;
          if (headerBytes > 64 * 1024) { stop(new Error('Upstream profile headers exceed 64 KiB')); return; }
          const lines = pending.subarray(0, end).toString('latin1').split('\r\n');
          pending = pending.subarray(end + 4);
          const status = /^HTTP\/(?:1\.[01]|2|3) ([0-9]{3})(?: |$)/.exec(lines.shift());
          if (!status) { stop(new Error('Invalid upstream profile HTTP response')); return; }
          const headers = new Map();
          for (const line of lines) {
            const field = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);
            if (!field || /[\x00-\x08\x0a-\x1f\x7f]/.test(field[2])) {
              stop(new Error('Invalid upstream profile HTTP headers')); return;
            }
            const name = field[1].toLowerCase();
            headers.set(name, headers.has(name) ? `${headers.get(name)}, ${field[2].trim()}` : field[2].trim());
          }
          const code = Number(status[1]);
          if (code >= 100 && code < 200 && code !== 101) continue;
          response = { status: code, headers };
        }
        chunk = pending;
        pending = Buffer.alloc(0);
        // Redirects, 304 and errors need only headers; never download an unbounded error body.
        if (response.status !== 200) { stop(); return; }
      }
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_PROFILE_BYTES) { stop(new Error('Upstream profile exceeds 1 MiB')); return; }
      chunks.push(chunk);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (!response || (!stopped && code !== 0)) { reject(profileConnectionError()); return; }
      resolve({ ...response, body: Buffer.concat(chunks) });
    });
  });
}
async function fetchProfile(url, cache, selection, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let target = url;
  for (let hop = 0; hop <= 5; hop++) {
    const response = await curlProfileRequest(target, cache?.etag, selection, deadline);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Profile redirect has no location');
      let redirected;
      try { redirected = new URL(location, target).href; }
      catch { throw new Error('Invalid upstream profile redirect'); }
      target = secureUrl(redirected, selection);
      continue;
    }
    if (response.status === 304) {
      if (!cache) throw new Error('Profile returned 304 without a valid same-source cache');
      return { profile: cache.profile, etag: cache.etag };
    }
    if (response.status !== 200) throw new Error(`Profile returned HTTP ${response.status}`);
    let profile;
    try { profile = validateProfile(JSON.parse(response.body.toString('utf8')), selection); }
    catch { throw new Error('Invalid upstream profile response'); }
    const etag = response.headers.get('etag');
    return { profile, ...(etag ? { etag } : {}) };
  }
  throw new Error('Too many upstream profile redirects');
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function snapshot(selection, profile, cache) {
  return freeze({
    github: { ...DIRECT_GITHUB, ...profile?.providers.github },
    trust: structuredClone(selection.settings?.trust || DEFAULT_TRUST),
    revision: profile?.revision ?? 'direct',
    allowHttp: selection.allowHttp,
    source: { ...selection.source },
    ...(cache ? { checkedAt: cache.checkedAt } : {}),
  });
}
export async function prepareUpstreams(options = {}) {
  const selection = resolveSelection(options);
  const now = options.now ?? Date.now(), ttlMs = options.ttlMs ?? DEFAULT_TTL_MS, timeoutMs = options.timeoutMs ?? 5000;
  let cache = readCache(selection), profile;
  const initialCacheSource = lockOwner(selection.files.cache)?.sourceUrl;
  const initialSavedSource = JSON.stringify(selection.settings?.source);
  let reselect = false;
  if (!selection.url) {
    if (options.force) throw new Error('Upstream refresh is not applicable to direct or local sources');
    if (selection.source.type === 'local') profile = validateProfile(readJson(selection.source.path), selection);
  } else if (!options.readOnly && (options.force || !fresh(cache, now, ttlMs))) {
    let unlock;
    try {
      unlock = await lockCache(selection, timeoutMs + 1000);
      // An older waiter must not overwrite a newer source selection/cache generation.
      let currentSaved;
      try { currentSaved = readJson(selection.files.settings, true); }
      catch { throw Object.assign(new Error('Saved upstream settings became invalid during refresh'), { code: 'UPSTREAM_SOURCE_CHANGED' }); }
      if (selection.selectedBy === 'saved' && JSON.stringify(currentSaved?.source) !== initialSavedSource) {
        reselect = true;
      }
      const currentCacheSource = lockOwner(selection.files.cache)?.sourceUrl;
      if (!reselect && currentCacheSource !== selection.url && currentCacheSource !== initialCacheSource) {
        throw Object.assign(new Error('Upstream source changed while waiting for refresh; retry the operation'), { code: 'UPSTREAM_SOURCE_CHANGED' });
      }
      cache = readCache(selection); // Another process may have refreshed while we waited.
      if (!reselect && (options.force || !fresh(cache, options.now ?? Date.now(), ttlMs))) {
        const result = await fetchProfile(selection.url, cache, selection, timeoutMs);
        const next = { schemaVersion: 1, sourceUrl: selection.url, ...result, checkedAt: options.now ?? Date.now() };
        atomicJson(selection.files.cache, next);
        cache = next;
      }
    } catch (err) {
      if (err.code === 'UPSTREAM_SOURCE_CHANGED') throw err;
      const connectionHint = err.code === 'UPSTREAM_PROFILE_CONNECTION' ? '; profile retrieval uses curl and its proxy environment (HTTPS_PROXY/ALL_PROXY/NO_PROXY). Check proxy connectivity or use --upstream-config with a downloaded local file (see README)' : '';
      const lockHint = err.code === 'UPSTREAM_LOCK_TIMEOUT' ? `; timed out waiting for refresh lock: ${err.lockPath} (check its owner before removing it)` : '';
      if (options.force || !cache) throw new Error('Upstream refresh failed; no new snapshot saved' + (cache ? ' (previous cache preserved)' : ' and no valid same-source cache is available') + lockHint + connectionHint);
      (options.warn || console.error)('Upstream refresh failed; continuing with the last valid same-source cache' + lockHint + connectionHint + '.');
    } finally { unlock?.(); }
  }
  if (reselect) return prepareUpstreams(options);
  profile ||= cache?.profile;
  const resolved = selection.url && !profile ? null : snapshot(selection, profile, cache);
  return { selection, snapshot: resolved, cacheStatus: selection.url ? cache ? fresh(cache, options.now ?? Date.now(), ttlMs) ? 'fresh' : 'expired' : 'missing-or-invalid' : 'not-applicable' };
}
export function getUpstreamSnapshot() { return operation.getStore()?.snapshot || DIRECT_SNAPSHOT; }
export function withUpstreamSnapshot(prepared, fn) {
  if (!prepared.snapshot) throw new Error('No valid upstream snapshot');
  return operation.run(prepared, fn);
}
/** Explicit configuration is the only source writer; operational flag/env inputs never save. */
export function setUpstreamSource(value, options = {}) {
  const selection = resolveSelection({ ...options, source: sourceFromValue(value) });
  // Local profiles must exist and be valid now; remote URLs are fetched by the
  // next consuming operation, so configuring a source needs no network access.
  if (selection.source.type === 'local') validateProfile(readJson(selection.source.path), selection);
  saveSourceSettings(selection, { schemaVersion: 1, source: selection.source, trust: selection.settings?.trust ?? DEFAULT_TRUST });
}
export function clearUpstreamSource(options = {}) {
  // Explicit clear is independent of ambient source overrides (including empty values).
  const selection = resolveSelection({ ...options, source: { type: 'direct' } });
  if (!selection.settings?.source) return;
  saveSourceSettings(selection, { schemaVersion: 1, trust: selection.settings.trust });
}
function saveSourceSettings(selection, settings) {
  try { atomicJson(selection.files.settings, settings); }
  catch { throw new Error('Upstream source settings could not be saved; previous settings preserved'); }
}
export function githubUrl(action, repo, params = {}, selected = getUpstreamSnapshot()) {
  safePath(repo, 'GitHub repository');
  const parts = repo.split('/');
  if (parts.length !== 2 || parts.some(part => !part)) throw new Error('GitHub repository requires owner/name');
  const encodedRepo = parts.map(encodeURIComponent).join('/');
  const encodePath = (value, label) => safePath(value, label).split('/').map(encodeURIComponent).join('/');
  const ref = () => encodePath(params.ref, 'GitHub ref');
  let base = 'apiBase', relative;
  switch (action) {
    case 'tags': relative = `repos/${encodedRepo}/tags?per_page=100`; break;
    case 'contents': relative = `repos/${encodedRepo}/contents/${encodePath(params.path, 'GitHub file path')}?ref=${encodeURIComponent(safePath(params.ref, 'GitHub ref'))}`; break;
    case 'raw': base = 'rawBase'; relative = `${encodedRepo}/${ref()}/${encodePath(params.path, 'GitHub file path')}`; break;
    case 'archive':
      if (!['tag', 'branch'].includes(params.refType)) throw new Error('Invalid GitHub archive ref type');
      base = 'downloadBase'; relative = `${encodedRepo}/archive/refs/${params.refType === 'tag' ? 'tags' : 'heads'}/${ref()}.tar.gz`; break;
    case 'tarball': relative = `repos/${encodedRepo}/tarball/${ref()}`; break;
    case 'releaseLatest': relative = `repos/${encodedRepo}/releases/latest`; break;
    case 'releaseAsset': base = 'downloadBase'; relative = `${encodedRepo}/releases/download/${ref()}/${encodePath(params.asset, 'GitHub asset')}`; break;
    default: throw new Error('Unknown GitHub URL action');
  }
  return new URL(relative, selected.github[base]).href;
}
export function upstreamStatus(prepared, { resolved = false, env = process.env } = {}) {
  const { selection, snapshot: current, cacheStatus } = prepared;
  const source = selection.url ? `${selection.source.type}: ${new URL(selection.url).host}` : selection.source.type;
  return {
    source, selectedBy: selection.selectedBy, revision: current?.revision ?? null,
    checkedAt: current?.checkedAt ? new Date(current.checkedAt).toISOString() : null, cacheStatus,
    ...(resolved && current ? { endpoints: Object.fromEntries(Object.entries(current.github).map(([key, url]) => [key, { url, direct: url === DIRECT_GITHUB[key], tokenPolicy: ['api.github.com', 'raw.githubusercontent.com', 'github.com'].includes(new URL(url).host) ? 'existing GitHub authentication' : current.trust.forwardGitHubToken && current.trust.allowedHosts.includes(new URL(url).host) ? 'locally authorized when requested; redirects rechecked' : 'no token forwarding' }])), trust: current.trust } : {}),
    npm: Object.fromEntries(['npm_config_registry', 'npm_config_better_sqlite3_binary_host_mirror'].map(key => [key, env[key] === undefined ? 'unset (npm defaults/config apply)' : 'set'])),
  };
}
