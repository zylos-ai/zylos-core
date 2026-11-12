# Locked memory file writes and appends

Component callers can replace an existing regular file under `$ZYLOS_DIR/memory`
without racing a Memory Sync that has already read it. First read the complete
page and its matching raw-byte hash together:

```sh
node scripts/memory-write.js --read --path reference/preferences.md
```

Read success is `{ "ok": true, "data": { "path": "...", "sha256": "...", "text": "..." } }`.
The hash and complete text come from the same byte snapshot. Read mode uses the
same memory-relative path and symlink restrictions as writing; missing files
return `MEMORY_FILE_NOT_FOUND`, invalid or escaping paths return `INVALID_MEMORY_PATH`.
It takes no lock, creates or changes no files, ignores active Sync markers, and
does not consume stdin or observe runtime identity.

For callers that need whole-file replacement, use the hash from the read response
or the previous successful write. Do not obtain a standalone hash with `sha256sum`
or another command that omits the page content. After `MEMORY_CONFLICT`, reread
with `--read`, merge the complete content, and retry with that new snapshot's hash.
These read and replacement modes remain available for other callers; one-time
reference reorganization uses only append mode for existing pages.
Supply complete new content via stdin when writing:

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
