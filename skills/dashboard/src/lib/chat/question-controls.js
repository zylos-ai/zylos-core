import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.js';
import { ChatAnswers } from './answers.js';
import { parseC4Content } from '../../../../comm-bridge/scripts/c4-content-schema.js';

/** Apply only an explicit control from an already verified authoritative out row. */
export function recordQuestionControl(row, { env = process.env } = {}) {
  const parsed = parseC4Content(row.content);
  if (parsed.kind !== 'envelope' || parsed.envelope.kind !== 'control') return null;
  const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  const file = path.join(zylosDir, 'components/dashboard/dashboard.db');
  let store;
  try {
    if (!fs.existsSync(file)) throw new Error('Dashboard database unavailable');
    store = new Store(file);
    return new ChatAnswers({ store }).control({ sessionGroup: row.session_group,
      endpointId: row.endpoint_id, envelope: parsed.envelope });
  } finally { store?.close(); }
}
