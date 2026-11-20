import Database from 'better-sqlite3';
import { createStore } from '../../skills/comm-bridge/scripts/c4-v2-store.js';

const [, , filename, runId] = process.argv;
const db = new Database(filename, { fileMustExist: true });
db.function('stop_worker', () => process.kill(process.pid, 'SIGKILL'));
db.exec(`CREATE TEMP TRIGGER stop_before_phase_commit
  BEFORE UPDATE OF phase ON mode_transitions WHEN NEW.phase='cutover'
  BEGIN SELECT stop_worker(); END`);
createStore(db).setModeTransitionPhase(runId, 'cutover');
