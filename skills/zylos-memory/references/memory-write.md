# Locked memory file writes

Component callers can replace an existing regular file under `$ZYLOS_DIR/memory`
without racing a Memory Sync that has already read it:

```sh
node scripts/memory-write.js --path reference/preferences.md --sha256 EXPECTED_SHA256 < new-content
```

Paths are relative to `memory/`. The memory root is resolved with realpath and
must name a directory; the root itself may be a symlink. Absolute paths,
`.`/`..` components, symlinks below the resolved root, non-files and missing files
are rejected. The expected lowercase hex SHA-256
digest is computed over the original raw bytes. Stdin supplies the new bytes;
callers retain responsibility for any text-type or size policy.

`session-groups/<group>/...` takes that group's existing `memory.lock`; all other
files take Origin's existing lock in both single and multi mode. Lock acquisition
uses the shared ten-second default timeout. Under that lock, the command refuses
a valid Sync marker immediately with `SYNC_BUSY`, checks the content hash, then
publishes a same-directory temporary file using rename, preserving permissions.
It checks both `sync.lock` and `origin-sync.lock` for Origin. Expired or old-run
markers follow the existing Sync status rules. It never waits for Sync to finish.

Stdout is one JSON object, following the memory reader's JSON envelope:

- Success: `{ "ok": true, "data": { "path": "...", "sha256": "..." } }`.
- Failure: `{ "ok": false, "error": { "code": "...", "message": "..." } }`.
- `MEMORY_CONFLICT` also returns `error.current` with `text` and `sha256`.

Exit codes reuse `sync-cli.js`: success is 0, `LOCK_TIMEOUT`/`SYNC_BUSY` are 2,
other writer failures are 1. A conflict or busy error leaves the file unchanged.
There is no new-file/delete operation, Sync token, new persistent state or new
locking protocol. Dashboard integration is a separate caller change.
