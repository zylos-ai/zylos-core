import Database from '../../../../comm-bridge/scripts/sqlite-driver.js';
import os from 'node:os';
import path from 'node:path';
import { inspectDatabase, TARGET_SCHEMA_VERSION } from '../schema.js';
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
  let db;
  try {
    db = new Database(file, { fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    if (inspectDatabase(db).currentVersion !== TARGET_SCHEMA_VERSION) {
      throw new Error('Dashboard database version does not match the code; complete the upgrade or restart Dashboard.');
    }
    db.prepare(`INSERT INTO chat_questions
      (c4_id, session_group, endpoint_id, message_id, interrupt_id, question_summary, constraints, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'paused') ON CONFLICT(c4_id) DO NOTHING`).run(
      String(row.id), row.session_group, row.endpoint_id, envelope.messageId, envelope.interruptId,
      envelope.questionSummary, JSON.stringify({ block, interrupt: envelope.interrupt }));
    return db.prepare('SELECT * FROM chat_questions WHERE c4_id = ?').get(String(row.id));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw Object.assign(new Error('This question reference belongs to another C4 row.'), { code: 'QUESTION_REFERENCE_CONFLICT' });
    }
    throw Object.assign(new Error('Dashboard question registration failed; repair must use the existing C4 reference without resending.'), { code: 'QUESTION_REGISTRATION_FAILED' });
  } finally { db?.close(); }
}
