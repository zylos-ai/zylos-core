/** Persist only new terminal delivery receipts; historical failures stay untouched. */
export function migrateToV5(db) {
  db.exec(`CREATE TABLE failure_receipts (
    conversation_id INTEGER PRIMARY KEY,
    reason TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','queued','sent','suppressed','uncertain','failed')),
    receipt_conversation_id INTEGER UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_failure_receipts_pending ON failure_receipts(state, conversation_id)`);
}
