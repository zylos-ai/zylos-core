# Dashboard DB Maintenance

`dashboard.db` uses SQLite. New databases enable `auto_vacuum=INCREMENTAL` before creating tables, so retention can reclaim completely free pages without rewriting the whole database.

## Automatic Maintenance

The dashboard runs hourly retention cleanup:

- `usage_event`: 90 days
- `ttft%` and `turn_duration%`: 90 days
- `statusline_summary`: 30 days
- `system_summary`: 14 days
- `pm2_summary` and legacy `pm2_%`: 7 days
- `otel_*` sources: preserved (sample data for future use)
- other legacy metrics: 90 days

After each hourly cleanup, incremental reclamation runs in chunks of at most 1,000 pages, yielding to the event loop between chunks. Each run requests at most 10,000 pages (about 39 MiB at a 4 KiB page size); remaining free pages wait for later hourly runs. The page limit bounds work, not wall-clock latency, which depends on disk speed. WAL checkpointing makes the recovered space visible in the database file. Incremental vacuum frees completely empty pages; it does not repack partially empty pages.

Existing databases are **not converted during startup**. During hourly maintenance on Sunday (UTC), an unconverted database is considered for a one-time switch:

- Effective data is `(page_count - freelist_count) * page_size` and must be at most 2 GiB. The bloated file size is not the limit.
- Available space on the database filesystem must be at least twice that effective data size. If space cannot be determined, conversion is skipped.
- Eligible databases run `PRAGMA auto_vacuum=INCREMENTAL; VACUUM` once. The `VACUUM` is synchronous and holds a write lock: the dashboard and Observer can pause for several seconds (or longer on slower storage). It runs after service startup, never on the startup readiness path.
- Ineligible databases log the reason, effective bytes, available bytes, and this document's path. The process retries on a later Sunday, not on every hourly tick that day.
- `PRAGMA auto_vacuum=2` is the persistent completion marker; no schema migration number is consumed. Once converted, there is no weekly full `VACUUM`.

The automatic conversion is transactional at SQLite's file-rewrite boundary: a failed `VACUUM` leaves the original database usable, and maintenance logs the error. The attempt date is retained even on failure, so it retries on a later Sunday rather than every hourly tick in the same process. Keep normal database backups; for a planned manual conversion, take the backup below first.

## Manual Compaction For Large Databases

Use this for already-bloated databases after retention has removed old rows.

1. Check effective data and available disk. Budget at least twice the effective data size as free space for conversion, plus space for the rollback backup. Allow a maintenance window for the synchronous rewrite.

   ```bash
   df -h ~/zylos
   ls -lh ~/zylos/components/dashboard/dashboard.db
   sqlite3 ~/zylos/components/dashboard/dashboard.db "SELECT (p.page_count - f.freelist_count) * s.page_size AS effective_bytes FROM pragma_page_count p, pragma_freelist_count f, pragma_page_size s;"
   ```

2. Stop the dashboard so no live writes compete with the exclusive SQLite lock.

   ```bash
   pm2 stop zylos-dashboard
   ```

3. Take a rollback backup before rewriting the file.

   ```bash
   cp ~/zylos/components/dashboard/dashboard.db ~/zylos/components/dashboard/dashboard.db.bak
   cp ~/zylos/components/dashboard/dashboard.db-wal ~/zylos/components/dashboard/dashboard.db-wal.bak 2>/dev/null || true
   cp ~/zylos/components/dashboard/dashboard.db-shm ~/zylos/components/dashboard/dashboard.db-shm.bak 2>/dev/null || true
   ```

4. Enable incremental reclamation and compact the database once.

   ```bash
   sqlite3 ~/zylos/components/dashboard/dashboard.db "PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize; PRAGMA auto_vacuum;"
   ```

   The last result must be `2`. Later hourly maintenance can now reclaim free pages automatically.

5. Restart and validate.

   ```bash
   pm2 start zylos-dashboard
   npm run smoke:api
   ```

6. If validation fails, stop the dashboard, restore the `.bak` files, then start it again.

   ```bash
   pm2 stop zylos-dashboard
   cp ~/zylos/components/dashboard/dashboard.db.bak ~/zylos/components/dashboard/dashboard.db
   cp ~/zylos/components/dashboard/dashboard.db-wal.bak ~/zylos/components/dashboard/dashboard.db-wal 2>/dev/null || true
   cp ~/zylos/components/dashboard/dashboard.db-shm.bak ~/zylos/components/dashboard/dashboard.db-shm 2>/dev/null || true
   pm2 start zylos-dashboard
   ```
