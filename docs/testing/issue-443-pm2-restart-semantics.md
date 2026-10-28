# Issue #443 E2E Verification

This change is intended to remove plain `pm2 restart` from the main core-service restart flows and replace it with ecosystem-based restarts.

## Quick Run

From the repo root:

```bash
bash scripts/e2e/issue-443-pm2-restart-semantics.sh
```

Expected output:

```text
== service restart ==
== runtime switch ==
== component rollback restart ==
E2E OK
```

## What This Verifies

The script creates a temporary fake home directory, a fake `pm2` binary, and a fake `codex` binary, then runs these flows against the real CLI/modules:

1. `zylos restart`
   Confirms core service restart goes through `pm2 start <ecosystem> --only <name>` and does not emit plain `pm2 restart`.

2. `zylos runtime codex`
   Confirms runtime switch restart for `activity-monitor` and `c4-dispatcher` also goes through the ecosystem path and does not emit plain `pm2 restart`.

3. `rollback()` in `cli/lib/upgrade.js`
   Confirms component rollback restart uses the component's own `ecosystem.config.cjs` when it exists, instead of plain `pm2 restart`.

Core self-upgrade now uses transaction recovery. The historical `rollbackSelf()`
case was retired with the old parent orchestration. Its protected replacement is
covered by `cli/lib/__tests__/upgrade-recovery.test.js` through the isolated Node
runner; this manual harness does not verify upgrade recovery.

## Manual Review Notes

The harness is intentionally PM2-free:

- `pm2` is replaced with a fake binary that logs every invocation
- assertions are made against the captured PM2 command log
- the script fails immediately if a required ecosystem restart is missing or an unexpected plain `pm2 restart` appears

## Related Unit Tests

Run the node:test subset used for this change:

```bash
node scripts/run-node-tests.js \
  cli/lib/__tests__/pm2.test.js \
  cli/lib/__tests__/upgrade-recovery.test.js \
  cli/lib/__tests__/runtime-setup.test.js \
  cli/lib/__tests__/codex.test.js \
  cli/lib/__tests__/fs-utils.test.js \
  cli/lib/__tests__/sync-settings-hooks.test.js
```
