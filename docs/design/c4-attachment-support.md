# Design: C4 Attachment Support (Issue #125)

## Problem

`c4-send.js` only supports plain text. Sending images/files requires bypassing C4 and calling platform APIs directly. This breaks the unified communication layer and loses the audit trail.

## Proposed CLI

```bash
# Text + attachment
node c4-send.js <channel> <endpoint> "caption text" --attach /path/to/file

# Attachment only (no caption)
node c4-send.js <channel> <endpoint> --attach /path/to/file
```

Existing text-only calls remain unchanged (fully backward-compatible).

## File Type Detection

Auto-detect by extension, mapped to media types the channel scripts already understand:

| Extensions | Media Type | Channel Protocol |
|---|---|---|
| .png .jpg .jpeg .gif .webp .bmp .svg | `image` | `[MEDIA:image]/path` |
| .mp4 .mov .avi .webm .mkv | `video` | `[MEDIA:video]/path` |
| Everything else | `file` | `[MEDIA:file]/path` |

Channel scripts (telegram, lark, feishu) already parse `[MEDIA:type]path` — no channel-side changes needed.

## File Archival

Outbound files are copied to a date-partitioned archive before sending:

```
~/zylos/comm-bridge/attachments/outbound/YYYY-MM-DD/<basename>-<hash12>.<ext>
```

- `ATTACHMENTS_DIR` is already defined in `c4-config.js`
- Content hash (SHA-256, first 12 chars) prevents filename collisions
- Original file is never modified or moved

## Audit Trail

The DB conversation record stores a human-readable summary:

```
caption text
[attachment: filename.png (image, 45230 bytes)]
```

Full attachment metadata (original path, archived path, size, mime type) is **not** stored in the conversations table in this iteration. If we need structured metadata later (e.g., for inbound media archival), we can add it via the DB migration framework (#42).

## Flow

```
c4-send.js --attach /tmp/screenshot.png "Check this"
  │
  ├─ 1. Validate: file exists, is a regular file
  ├─ 2. Detect media type: .png → image
  ├─ 3. Archive: copy to attachments/outbound/2026-02-23/screenshot-a1b2c3d4e5f6.png
  ├─ 4. DB audit: insert conversation with summary text
  ├─ 5. Caption (if present): send caption as text message via channel script
  └─ 6. Media: spawn channel script with [MEDIA:image]/archived/path
```

## Caption Handling

When both caption and attachment are provided, two messages are sent:
1. Caption as plain text (via channel send.js)
2. Attachment as `[MEDIA:type]` (via channel send.js)

This is the simplest approach that works across all channels. Platform-native caption support (e.g., Telegram's `sendPhoto` with `caption` param) would require channel script changes and is out of scope for P0.

## Files to Modify

| File | Change |
|---|---|
| `c4-send.js` | Parse `--attach` flag, archival, media type detection, dual-message send |
| `references/c4-send.md` | Update usage docs with attachment examples |

## Files NOT Modified

- `c4-db.js` — no schema changes in P0 (audit uses plain text summary)
- `init-db.sql` — no schema changes
- Channel send scripts — already handle `[MEDIA:*]` protocol

## Scope

**P0 (this issue):** Outbound attachments only.

**Future (separate issues):**
- Inbound media archival (channel bots archive received media)
- Multi-attach (multiple files in one send)
- Structured attachment metadata in DB (via #42 migration framework)
- Attachment cleanup policy (age-based pruning of archive)
- Platform-native caption support (single message with caption + media)

## Open Questions

1. **Should `--attach` validate file size?** Large files may fail on platform APIs (Telegram: 50MB for bots). Should c4-send enforce a limit, or let the channel script handle the error?

2. **Should caption + media be atomic?** If caption succeeds but media fails, we've sent a partial message. Should we skip the caption and only send media with a built-in caption (requires channel script changes)?
