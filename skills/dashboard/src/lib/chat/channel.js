import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { registerQuestion } from './questions.js';
import { validateDeliveryPacket } from '../../../../comm-bridge/scripts/c4-content-schema.js';

const mismatch = () => Object.assign(new Error('Dashboard delivery does not match an authoritative outbound row.'), { code: 'DELIVERY_MISMATCH' });

/** Verify the authoritative outbound row before any question registration. */
export function acceptDelivery(packet, { env = process.env } = {}) {
  if (!packet || packet.channel !== 'dashboard'
    || !['number', 'string'].includes(typeof packet.c4_id)) throw mismatch();
  const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  let db, row;
  try {
    db = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'), { readonly: true, fileMustExist: true });
    row = db.prepare(`SELECT CAST(id AS TEXT) AS id, direction, channel, endpoint_id, session_group, content
      FROM conversations WHERE id = ?`).get(packet.c4_id);
    if (!row || row.direction !== 'out' || !validateDeliveryPacket(packet, row)) throw mismatch();
  } catch (error) {
    if (error.code === 'DELIVERY_MISMATCH') throw error;
    throw Object.assign(new Error('Cannot read the authoritative C4 delivery row.'), { code: 'C4_READ_FAILED' });
  } finally { db?.close(); }
  registerQuestion(row, { env });
  return row;
}
