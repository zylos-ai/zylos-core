import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { inspectDatabase, TARGET_SCHEMA_VERSION } from '../schema.js';
import { ChatAnswers } from './answers.js';
import { parseC4Content } from '../../../../comm-bridge/scripts/c4-content-schema.js';

/** Apply only an explicit control from an already verified authoritative out row. */
export function recordQuestionControl(row, { env = process.env } = {}) {
  const parsed = parseC4Content(row.content);
  if (parsed.kind !== 'envelope' || parsed.envelope.kind !== 'control') return null;
  const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  const file = path.join(zylosDir, 'components/dashboard/dashboard.db');
  let db;
  try {
    try {
      try {
        db = new Database(file, { fileMustExist: true });
        db.pragma('busy_timeout = 5000');
        if (inspectDatabase(db).currentVersion !== TARGET_SCHEMA_VERSION) {
          throw new Error('Dashboard database version does not match the code');
        }
      } catch (error) {
        throw Object.assign(new Error('Dashboard database unavailable or incompatible; complete the upgrade or restart Dashboard.', { cause: error }), { code: 'QUESTION_CONTROL_FAILED' });
      }
      return new ChatAnswers({ store: { db } }).control({ sessionGroup: row.session_group,
        endpointId: row.endpoint_id, envelope: parsed.envelope });
    } finally { db?.close(); }
  } catch (error) {
    // The channel verified this outbound C4 row before applying its overlay.
    // Preserve the cause while distinguishing application failure from an
    // uncertain send, so callers do not try to store the control again.
    error.code ||= 'QUESTION_CONTROL_FAILED';
    const causes = {
      chat_question_not_paused: 'The original or replacement question is no longer waiting for an answer (it may be answered, stopped or replaced).',
      chat_question_not_found: 'The original or replacement question has not been registered in this conversation.',
      chat_question_forbidden: 'The control does not match the original question message or channel endpoint in this conversation.',
      invalid_chat_control: 'The control action is invalid for this question.',
      chat_question_unavailable: 'The saved question constraints are unavailable or invalid.',
    };
    if (causes[error.code]) error.message = causes[error.code];
    error.storedControlFailure = true;
    throw error;
  }
}
