// Seed persisted data that only older versions of Core can produce.
export function seedHistoricalAbsorption(db, runId, ids, { complete = false } = {}) {
  if (ids === undefined) {
    ids = db.prepare("SELECT id FROM conversations WHERE direction='in' AND status='pending' ORDER BY id").pluck().all();
  }
  const cutoff = db.prepare('SELECT COALESCE(MAX(id),0) FROM conversations').pluck().get();
  db.prepare("UPDATE conversations SET status='switch_absorbed' WHERE id IN (SELECT value FROM json_each(?))")
    .run(JSON.stringify(ids));
  db.prepare("UPDATE mode_transitions SET phase=?, cutoff=?, coverage_snapshot='{}', absorbed_ids=? WHERE run_id=?")
    .run(complete ? 'complete' : 'converting', cutoff, JSON.stringify(ids), runId);
}
