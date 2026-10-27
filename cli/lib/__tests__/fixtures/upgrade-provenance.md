# Frozen Upgrade Sources

These files are unchanged copies from zylos-core:

- `upgrade-0.9.0`: `95b5850e2654fdc48b333c02b158acda2d536466`
- `upgrade-0.9.1`: `b0ae22aec5c032826d5e38a0845dfc50b624b477`

Each directory retains `cli/lib/self-upgrade.js`, `upgrade-maintenance.cjs`,
`upgrade-recovery.cjs`, `core-db-backup-worker.js`, and `cli/commands/component.js`.
The component file exercises the unchanged parent CLI result consumer. The recovery tests
execute these copies so shallow checkouts do not require historical Git objects.
