import Database from '../../../../comm-bridge/scripts/sqlite-driver.js';
import os from 'node:os';
import path from 'node:path';
import { registerQuestion } from './questions.js';
import { recordQuestionControl } from './question-controls.js';
import { parseC4Content, validateDeliveryPacket } from '../../../../comm-bridge/scripts/c4-content-schema.js';
import { withChatAttachments } from './attachments.js';
import { requestConversationName } from './auto-name.js';

const mismatch = () => Object.assign(new Error('Dashboard delivery does not match an authoritative outbound row.'), { code: 'DELIVERY_MISMATCH' });

/** Verify the authoritative outbound row before any question registration. */
export function acceptDelivery(packet, { env = process.env } = {}) {
  if (!packet || packet.channel !== 'dashboard'
    || !['number', 'string'].includes(typeof packet.c4_id)) throw mismatch();
  const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  let db, row;
  try {
    db = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'), { readonly: true, fileMustExist: true });
    row = db.prepare(`SELECT CAST(id AS TEXT) AS id, direction, channel, endpoint_id, session_group, content, delivery_action
      FROM conversations WHERE id = ?`).get(packet.c4_id);
    if (!row || row.direction !== 'out' || !validateDeliveryPacket(packet, row)) throw mismatch();
  } catch (error) {
    if (error.code === 'DELIVERY_MISMATCH') throw error;
    throw Object.assign(new Error('Cannot read the authoritative C4 delivery row.'), { code: 'C4_READ_FAILED' });
  } finally { db?.close(); }
  registerQuestion(row, { env });
  recordQuestionControl(row, { env });
  const parsed = parseC4Content(row.content);
  const blocks = parsed.kind === 'envelope' && parsed.envelope.kind === 'message'
    ? parsed.envelope.blocks.filter(block => ['x-zylos.image', 'x-zylos.file'].includes(block.type)) : [];
  if (blocks.length) {
    try {
      withChatAttachments(zylosDir, {}, service => {
        const linked = service.linkRow(row);
        if (linked.length !== blocks.length || linked.some(item => !item.available)) throw new Error('Attachment association unavailable');
      });
    } catch {
      throw Object.assign(new Error('Dashboard attachment association failed; history or collection will retry the existing C4 row.'),
        { code: 'ATTACHMENT_ASSOCIATION_FAILED', storedAttachmentFailure: true });
    }
  }
  try { requestConversationName(row, { env }); }
  catch (cause) {
    throw Object.assign(new Error('Dashboard conversation naming is unavailable.', { cause }),
      { code: 'CONVERSATION_NAMING_FAILED', storedNamingFailure: true });
  }
  return row;
}
