import { validKey } from './display-names.js';
import { sendJson } from '../http.js';

// Canonical detail owns read validation, including membership of historical keys.
export function workbenchGroupDetailKey(encoded) {
  try { return decodeURIComponent(encoded); }
  catch { throw Object.assign(new Error('Invalid session group'), { code: 'SESSION_GROUP_INVALID', statusCode: 400 }); }
}

export function workbenchGroupKey(encoded) {
  const key = workbenchGroupDetailKey(encoded);
  if (key !== 'origin' && !validKey(key)) {
    throw Object.assign(new Error('Invalid session group'), { code: 'SESSION_GROUP_INVALID', statusCode: 400 });
  }
  return key;
}

export function workbenchFailure(res, error) {
  if ([400, 413].includes(error.status)) {
    sendJson(res, error.status, { error: error.message });
    return;
  }
  const status = error.statusCode ?? 500;
  sendJson(res, status, { ok: false, error: { code: status === 500 ? 'internal_error' : error.code,
    message: status === 500 ? 'Request failed' : error.message } });
}
