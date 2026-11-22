import { validKey } from './display-names.js';
import { sendJson } from '../http.js';
import { listErrorBody } from '../list-query.js';

// Group observation reads own validation, including membership of historical names.
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
  sendJson(res, status, listErrorBody(status === 500
    ? { code: 'internal_error', message: 'Request failed' } : error));
}
