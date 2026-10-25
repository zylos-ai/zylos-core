import fs from 'node:fs';
import path from 'node:path';
import { durableJson, runtimeRoot } from './runtime-generation.js';

export const validRequestId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateRestartRequests(rows) {
  if (!Array.isArray(rows)) return false;
  const ids = new Set(); let manual = 0;
  for (const row of rows) {
    if (!object(row) || !validRequestId(row.requestId) || ids.has(row.requestId)
        || !Number.isSafeInteger(row.acceptedAt) || row.acceptedAt < 0
        || !Array.isArray(row.runIds) || !row.runIds.length || !row.runIds.every(nonempty)) return false;
    ids.add(row.requestId);
    let fields = ['requestId', 'reason', 'acceptedAt', 'runIds'];
    if (row.reason === 'manual_restart') {
      if (++manual > 1 || !['single', 'multi'].includes(row.mode) || !nonempty(row.expectedRunId)
          || row.runIds.length !== 1 || row.runIds[0] !== row.expectedRunId
          || (Object.hasOwn(row, 'expectedSessionId') && typeof row.expectedSessionId !== 'string')) return false;
      fields = [...fields, 'mode', 'expectedRunId', 'expectedSessionId'];
    } else if (row.reason !== 'upgrade') return false;
    if (Object.keys(row).some(key => !fields.includes(key))) return false;
  }
  return true;
}

export class RestartRequestStore {
  constructor({ file = path.join(runtimeRoot(), 'activity-monitor', 'restart-requests.json'), write = durableJson } = {}) {
    this.file = file; this.publish = write;
  }
  read() {
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw Object.assign(new Error('Restart requests are unreadable', { cause: error }), { code: 'requests_unreadable' }); }
    if (!validateRestartRequests(value)) throw Object.assign(new Error('Restart requests are invalid'), { code: 'requests_unreadable' });
    return value;
  }
  write(rows) {
    if (!validateRestartRequests(rows)) throw new TypeError('Invalid restart requests');
    this.publish(this.file, rows);
  }
  remove(requestId) {
    const rows = this.read();
    const next = rows.filter(row => row.requestId !== requestId);
    if (next.length !== rows.length) this.write(next);
  }
}
