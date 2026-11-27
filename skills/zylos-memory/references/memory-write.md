# Locked memory file writes and appends

Component callers can replace an existing regular file under `$ZYLOS_DIR/memory`
without overwriting changes made since their read. Read the complete file
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

`session-groups/<group>/...` takes that group's file lock. Shared paths take
the dream writer's lock. The writer checks the current content hash under the
lock and uses a same-directory rename to publish the replacement while
preserving permissions. The default lock acquisition timeout is ten seconds.

Stdout is one JSON object, following the memory reader's JSON envelope:

- Success: `{ "ok": true, "data": { "path": "...", "sha256": "..." } }`.
- Failure: `{ "ok": false, "error": { "code": "...", "message": "..." } }`.
- `MEMORY_CONFLICT` also returns `error.current` with `text` and `sha256`.

Exit codes are 0 for success, 2 for `LOCK_TIMEOUT`, and 1 for other writer
failures. A conflict or timeout leaves the file unchanged.

## Append a supplement and merge permitted header values

```sh
node scripts/memory-write.js --append --path reference/projects/example.md \
  --keys "new-alias, issue-123" --moved-from "projects.md old heading" <<'EOF'

## 整理补充（日期）
Useful missing facts.
EOF
```

Append mode neither needs nor accepts `--sha256`. It takes the same memory lock
as replacement mode. Inside that lock it reads
the latest file, merges only `Keys` and `Moved from` in the header (before the
first blank line), then appends stdin bytes verbatim. Values are comma-separated:
trim and deduplicate them while retaining existing order, then add new values in
supplied order. A missing field is added at the end of the header in page format.
Metadata values must be single-line strings; they cannot introduce other fields.
Status, Updated, Description, other header lines and existing body bytes remain
unchanged. Include any required paragraph separation and `整理补充（日期）` heading
in stdin. Empty stdin is `INVALID_INPUT`; missing files are
`MEMORY_FILE_NOT_FOUND`; path restrictions are the same as replacement mode.

A held file lock uses the same timeout as replacement mode. Success returns
the path and new SHA-256 digest. Each append merges with the file under the
lock, preserving changes from earlier writers.
