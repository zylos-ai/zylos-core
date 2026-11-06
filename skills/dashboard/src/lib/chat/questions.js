import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.js';
import { parseC4Content, makeQuestionSummary } from '../../../../comm-bridge/scripts/c4-content-schema.js';

/** Register only a question from an already verified authoritative C4 row. */
export function registerQuestion(row, { env = process.env } = {}) {
  const parsed = parseC4Content(row.content);
  if (parsed.kind === 'invalid') {
    throw Object.assign(new Error('Invalid Dashboard content.'), { code: 'INVALID_CONTENT' });
  }
  if (parsed.kind !== 'envelope' || parsed.envelope.kind !== 'message' || !parsed.envelope.interrupt) return null;
  const envelope = parsed.envelope;
  if (makeQuestionSummary(envelope) !== envelope.questionSummary) {
    throw Object.assign(new Error('Dashboard question summary is missing or inconsistent.'), { code: 'INVALID_CONTENT' });
  }
  const block = envelope.blocks.find(item => item.id === envelope.interrupt.blockId);
  const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  const file = path.join(zylosDir, 'components/dashboard/dashboard.db');
  let store;
  try {
    if (!fs.existsSync(file)) throw new Error('Dashboard database unavailable');
    store = new Store(file);
    store.db.prepare(`INSERT INTO chat_questions
      (c4_id, session_group, endpoint_id, message_id, interrupt_id, question_summary, constraints, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'paused') ON CONFLICT(c4_id) DO NOTHING`).run(
      String(row.id), row.session_group, row.endpoint_id, envelope.messageId, envelope.interruptId,
      envelope.questionSummary, JSON.stringify({ block, interrupt: envelope.interrupt }));
    return store.db.prepare('SELECT * FROM chat_questions WHERE c4_id = ?').get(String(row.id));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw Object.assign(new Error('This question reference belongs to another C4 row.'), { code: 'QUESTION_REFERENCE_CONFLICT' });
    }
    throw Object.assign(new Error('Dashboard question registration failed; repair must use the existing C4 reference without resending.'), { code: 'QUESTION_REGISTRATION_FAILED' });
  } finally { store?.close(); }
}
