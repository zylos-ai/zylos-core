# Manual restart admission-only session identity correction

The durable restart request now keeps only the expected run identity. Optional session identity stays in the incoming request validator and first-admission check, but is neither written to F9 nor compared when recognizing an already accepted request. The store rejects the removed extra field under its existing closed schema.

The existing admission regression verifies mismatched session rejection before publication, exact persisted fields, and idempotent retry after the live session changes. It now also checks that a retry carrying the current session is already accepted and that the removed durable field is rejected. This covers review P3-1 / the admission-only session identity contract.

Validation through the official isolated runner:

- Focused admission: 14 passed, no failures or skips.
- Selected A suites: 68 files, 717 tests, 716 passed, 1 opt-in skip, no failures.
- Command: `node scripts/run-node-tests.js skills/activity-monitor/scripts/__tests__/supervisor-admission.test.js`.
- Broader command: `node scripts/run-node-tests.js` followed by every path in `selection.json`.

No tmux command, format, parsing, runtime adapter, or stop implementation changed. The five-version matrix was not rerun for this schema/admission correction. Full repository/Jest, native macOS and downstream integration were not rerun. Logs, selection and changed-source SHA-256 hashes are included.
