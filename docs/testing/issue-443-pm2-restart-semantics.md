# Issue #443 E2E Verification

This change is intended to remove plain `pm2 restart` from the main core-service restart flows and replace it with ecosystem-based restarts.

## Related Unit Tests

Run the node:test subset used for this change:

```bash
node scripts/run-node-tests.js \
  cli/lib/__tests__/pm2.test.js \
  cli/lib/__tests__/upgrade-recovery.slow.test.js \
  cli/lib/__tests__/runtime-setup.test.js \
  cli/lib/__tests__/codex.test.js \
  cli/lib/__tests__/fs-utils.test.js \
  cli/lib/__tests__/sync-settings-hooks.test.js
```
