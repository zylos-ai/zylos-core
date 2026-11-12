# Locked memory file writes and appends

Component callers can replace an existing regular file under `$ZYLOS_DIR/memory`
without racing a Memory Sync that has already read it. Read the complete file
(for example with the Read tool) and retain its raw-byte hash. After
`MEMORY_CONFLICT`, read the file again, merge the current content with your
changes, and rewrite with the new hash. One-time reference reorganization uses
only append mode for existing pages. Supply complete new content on stdin:

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

## Append a supplement and merge permitted header values

```sh
node scripts/memory-write.js --append --path reference/projects/example.md \
  --keys "new-alias, issue-123" --moved-from "projects.md old heading" <<'EOF'

## 整理补充（日期）
Useful missing facts.
EOF
```

Append mode neither needs nor accepts `--sha256`. It takes the same memory lock
and checks the same Sync markers as replacement mode. Inside that lock it reads
the latest file, merges only `Keys` and `Moved from` in the header (before the
first blank line), then appends stdin bytes verbatim. Values are comma-separated:
trim and deduplicate them while retaining existing order, then add new values in
supplied order. A missing field is added at the end of the header in page format.
Metadata values must be single-line strings; they cannot introduce other fields.
Status, Updated, Description, other header lines and existing body bytes remain
unchanged. Include any required paragraph separation and `整理补充（日期）` heading
in stdin. Empty stdin is `INVALID_INPUT`; missing files are
`MEMORY_FILE_NOT_FOUND`; path restrictions are the same as replacement mode.

A live Sync marker returns `SYNC_BUSY`; retry the same append after Sync finishes.
A separately held memory lock uses the existing wait/`LOCK_TIMEOUT` behavior.
After the lock is available, active Sync markers are still checked before any
file mutation. Success returns the same path and new sha256 JSON as replacement.
There is no stale whole-page draft or caller-supplied hash to overwrite a
concurrent supplement: each append merges with the current file under the lock.
