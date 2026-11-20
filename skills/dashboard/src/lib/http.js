import { resolveCoreDirectory } from './core-modules.js';
import { projectApiTimestamps } from './wire-time.js';
import fs from 'node:fs';
import path from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

// Explicit command outcomes from Dashboard actions, scheduler CLI and Core
// supervisor admission. An unfamiliar command failure is an upstream failure.
const FAILURE_STATUSES = new Map([
  [400, ['invalid_runtime', 'invalid_mode', 'runtime_unsupported', 'invalid_model', 'invalid_effort', 'invalid_value', 'invalid_argument', 'invalid_args',
    'invalid_form', 'invalid_task', 'invalid_time', 'invalid_request', 'invalid_default', 'invalid_pricing',
    'model_pair_required', 'model_config_invalid', 'session_group_invalid', 'session_group_too_long',
    'prompt_starts_with_dashes', 'tz_unavailable', 'no_updates', 'reschedule_not_future', 'target_required', 'unknown_action']],
  [401, ['unauthorized', 'authentication_required', 'invalid_api_key']],
  [403, ['insufficient_scope', 'same_origin_required', 'local_cookie_required', 'origin_forbidden', 'auth_failed', 'auth_not_confirmed']],
  [404, ['task_not_found', 'group_not_found', 'session_group_not_found', 'unknown_key', 'unknown_agent', 'not_found']],
  [409, ['already_set', 'already_up_to_date', 'duplicate_request', 'environment_override', 'multi_session_required',
    'task_wrong_status', 'runtime_not_installed', 'target_scope_mismatch', 'target_mismatch', 'stale_target', 'task_ambiguous', 'transition_open', 'legacy_session_present', 'manual_restart_pending',
    'deletion_in_progress', 'request_conflict', 'not_multi', 'fence_conflict', 'restart_all_pending',
    'run_changed', 'other_fence', 'deletion_preview_stale', 'deletion_ownership_mismatch', 'draft_became_active']],
  [500, ['internal_error', 'db_write_failed', 'config_store_failed', 'credential_save_failed', 'set_failed']],
  [502, ['result_unknown', 'no_reply', 'scheduler_cli_failed', 'group_delete_result_unknown', 'instance_root_mismatch', 'upgrade_failed', 'wake_failed', 'restart_failed']],
  [503, ['hooks_not_ready', 'connect_failed', 'service_discovery_unavailable', 'group_delete_supervisor_unavailable', 'unknown_model_capabilities', 'config_unreadable', 'requests_unreadable',
    'identity_unavailable', 'dependency_unavailable', 'entry_not_open', 'not_ready', 'snapshot_unavailable', 'start_admission_closed', 'control_target_required']],
  [504, ['deadline_exceeded', 'timeout']],
].flatMap(([status, codes]) => codes.map(code => [code, status])));

function failureStatus(code) {
  return FAILURE_STATUSES.get(code.toLowerCase()) ?? 502;
}

/** HTTP errors are normalized; command envelopes are interpreted only at explicit adapter boundaries. */
export function jsonResponse(status, payload, { write = false, command = false } = {}) {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { data: payload };
  const rejected = ((write || command) && value.ok === false)
    || (command && (value.result === 'rejected' || value.result === 'unknown'));
  if (status >= 400 || rejected) {
    const detail = value.error && typeof value.error === 'object' ? value.error : {};
    const { status: detailStatus, ...diagnostics } = detail;
    const rawCode = String(detail.code || (typeof value.error === 'string' ? value.error : null) || value.code || value.reason || (status >= 500 ? 'internal_error' : 'request_failed'));
    const code = /^[a-z][a-z0-9_]*$/i.test(rawCode) ? rawCode : status >= 500 ? 'internal_error' : 'invalid_request';
    const message = String(detail.message || value.message || rawCode);
    const { error, ok, result, status: resultStatus, code: resultCode, message: resultMessage, ...metadata } = value;
    return {
      status: status >= 400 ? status : (Number.isInteger(resultStatus) && resultStatus >= 400 ? resultStatus : failureStatus(code)),
      body: { ...metadata, ...(resultStatus !== undefined && !Number.isInteger(resultStatus) ? { status: resultStatus } : {}), ok: false, error: { ...diagnostics, ...(detailStatus !== undefined && !Number.isInteger(detailStatus) ? { status: detailStatus } : {}), code, message } }
    };
  }
  if (command && value.result === 'done') {
    const { result, status: resultStatus, ...data } = value;
    return { status, body: { ok: true, ...data } };
  }
  if (!write) return { status, body: payload };
  const { status: resultStatus, ...data } = value;
  return { status, body: { ...data, ...(resultStatus !== undefined && !Number.isInteger(resultStatus) ? { status: resultStatus } : {}), ok: true } };
}

/** Action, group control and scheduler adapters are the only command-envelope consumers. */
export function sendCommandJson(res, status, payload) {
  // Supervisor restart admission reports this rejection in result, without an error/code.
  const outcome = payload?.ok === false && payload.result === 'stale_target'
    ? { ...payload, error: { code: 'stale_target', message: 'The target run changed; refresh before restarting' } } : payload;
  const response = jsonResponse(status, outcome, { write: true, command: true });
  sendJson(res, response.status, response.body);
}

export function sendJson(res, status, payload) {
  const response = jsonResponse(status, payload, { write: res.apiWrite === true });
  status = response.status;
  const body = JSON.stringify(projectApiTimestamps(res.apiPath, response.body), null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

export function sendText(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

export function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

export function readJsonBody(req, maxBytes = 64 * 1024, { allowEmpty = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        req.resume();
        return;
      }
      if (!overflow) chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflow) {
        const err = new Error('payload_too_large');
        err.status = 413;
        reject(err);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (allowEmpty && !raw.trim()) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('invalid_json');
        err.status = 400;
        reject(err);
      }
    });

    req.on('error', (err) => reject(err));
  });
}

// Metadata validators are weak: they identify unchanged files without hashing bodies.
function sendStaticFile(req, res, filePath, stat) {
  const ext = path.extname(filePath);
  const headers = {
    'content-type': MIME_TYPES[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-store' : 'no-cache'
  };
  if (ext !== '.html') {
    const tag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    headers.etag = `W/${tag}`;
    const validator = req.headers?.['if-none-match'];
    if ((req.method === 'GET' || req.method === 'HEAD') && typeof validator === 'string'
        && validator.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === tag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(filePath).pipe(res);
}

export function serveStatic(req, res, rootDir) {
  let pathname;
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendJson(res, 400, { error: 'invalid_request' });
    return true;
  }
  // One shared browser/Node module; do not expose the surrounding scripts tree.
  if (pathname === '/_assets/chat-schema.js') {
    const schema = path.resolve(rootDir, '..', '..', 'comm-bridge', 'scripts', 'c4-content-schema.js');
    try {
      const stat = fs.statSync(schema);
      if (!stat.isFile()) return false;
      sendStaticFile(req, res, schema, stat);
      return true;
    } catch {
      return false;
    }
  }
  if (pathname === '/_assets/runtime-descriptors.js') {
    try {
      const file = path.join(resolveCoreDirectory(), 'runtime/descriptors.js');
      const stat = fs.statSync(file);
      if (!stat.isFile()) return false;
      sendStaticFile(req, res, file, stat);
      return true;
    } catch {
      return false;
    }
  }
  const assetPath = pathname.startsWith('/_assets/') ? pathname.slice('/_assets/'.length) : null;
  const relative = assetPath || (pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const vendorPrefix = 'vendor/';
  const baseDir = relative.startsWith(vendorPrefix)
    ? path.resolve(rootDir, '..', 'node_modules', 'chart.js', 'dist')
    : rootDir;
  const localRelative = relative.startsWith(vendorPrefix) ? relative.slice(vendorPrefix.length) : relative;
  const candidate = path.resolve(baseDir, localRelative);

  if (candidate !== baseDir && !candidate.startsWith(`${baseDir}${path.sep}`)) {
    sendText(res, 403, 'forbidden');
    return true;
  }

  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return false;
  }

  const filePath = stat.isDirectory() ? path.join(candidate, 'index.html') : candidate;
  try {
    const fileStat = fs.statSync(filePath);
    if (!fileStat.isFile()) return false;
    sendStaticFile(req, res, filePath, fileStat);
    return true;
  } catch {
    return false;
  }
}
