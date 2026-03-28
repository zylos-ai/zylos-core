# runtime-work

Shared runtime ledger module for unified work lifecycle tracking.

## Purpose

This module provides:

1. `runtime_work` table for top-level work records
2. `runtime_work_event` append-only event table
3. Minimal APIs to create, transition, append events, and close out work
4. Minimal CLI for inspection (`list`, `show`)

## Scripts

- `scripts/db.js`: database bootstrap and path handling
- `scripts/api.js`: runtime work APIs
- `scripts/cli.js`: list/show CLI
- `init-db.sql`: table and index schema
