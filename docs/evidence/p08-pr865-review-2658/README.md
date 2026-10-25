# P08 internal review corrections

The internal sender uses the shared dataError factory. Write-error translation remains in sendInternal only; the CLI reports an error without a code as INTERNAL_ERROR. The exported sendInternal signature and successful result are unchanged for downstream consumers.

## Review mapping

| Item | Change |
| --- | --- |
| A1 | Removed committed source-rewriting controls for the reserved-name guard and split internal transaction. Real reserved-name rejection and SQL-trigger rollback remain. |
| A2 | Removed download.js source rewriting from the loader; the whole GitHub module fixture remains for offline resolution. |
| A4 / prior A P3-5 | Shared dataError; DB_BUSY/SQLITE mapping stays at the write boundary; uncoded CLI errors use INTERNAL_ERROR. |
| A5 / prior A P3-1 | No new rejection of the legacy --stdin internal path. |
| D3 | Removed the extra real five-second busy-timeout test without adding a replacement. |
| Prior A P3-2 | The existing invalid-forms case now includes exactly internal --group, asserting INVALID_ARGS and unchanged rows/heads. |
| Prior A P3-3 | The existing static skill case now checks failure-reporting and the prohibition on --session-group. |

## Retained test coverage

- IF-45 stdin success verifies exact two-row contents, identities and heads; invalid forms verify exit codes and no writes; empty body verifies no store or identity calls.
- IF-45 Origin/inherited environment, stale/missing/malformed identity, and fenced absent target cover sender attribution and queue-only behavior.
- IF-45 SQL-trigger failure verifies both rows and heads roll back. The real two-child barrier verifies reciprocal concurrent sends form uninterrupted pairs with monotonic heads.
- Reserved-name cases exercise registry, GitHub, local and archive resolution with internal/void rejection plus ordinary-name controls. Template/skill checks cover thread recognition and sending rules.
- Existing instruction-split tests guard approved template bytes; P01 primitives, transactions, messages and query suites exercise shared store behavior consumed here.

Source-rewriting negative controls are left to independent review. No product test hook or replacement lock-contention case was added. The P01 transaction regression suite itself uses its existing injected database proxy; no P01 test or implementation is changed by this revision.

## Validation

All commands use node scripts/run-node-tests.js with its isolated HOME/ZYLOS_DIR. selection.json records the exact seven-file list and changed source hashes.

- Focused two files: **13 passed, 0 failed**.
- Seven-file selection: **106 passed, 0 failed, 0 skipped**.
- Additional c4-send-cli.test.js: **7 passed, 3 failed**. The failing cases are the previously reported void cases: recording without a skill directory, avoiding a channel script, and stdin/heredoc input. This revision only changes the internal branch catch in c4-send.js; external/void behavior is unchanged. Earlier review proved these failures on the prior baseline; this run does not claim a fresh baseline comparison.

No full repository Node/Jest or tmux matrix rerun. No tmux construction, parsing or runtime implementation changed. Actual downstream delivery/reply, mode transitions and inbox/business integration are not claimed. No merge, release, deployment or dependency installation performed.
