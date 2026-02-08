# Decisions Log

Key decisions made during operation. Entries are added by Memory Sync.

### ESM-only for all zylos-core code
- **Date:** 2026-01-15
- **Decided by:** Howard
- **Decision:** All JavaScript in zylos-core must use ESM (import/export). No CommonJS.
- **Context:** Consistency across the codebase. Node.js 20+ supports ESM natively.
- **Status:** active
- **Importance:** 2
- **Type:** procedural

### Daily local git commit for memory persistence
- **Date:** 2026-02-01
- **Decided by:** Howard
- **Decision:** Use daily local git commits as the safety net for memory files. No remote push.
- **Context:** Considered SQLite WAL, rsync, and cloud sync. Git is simplest with zero dependencies.
- **Status:** active
- **Importance:** 2
- **Type:** strategic
