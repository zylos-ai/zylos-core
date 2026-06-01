# Dev Plan: writeCodexConfig() Merge Instead of Overwrite (#606)

## Summary

`writeCodexConfig()` treats Codex config files as zylos-owned and regenerates them from templates, destroying settings written by bootstrap, users, or Codex itself. Fix by establishing a shared-ownership model: zylos declares which keys it manages, merges only those keys, and preserves everything else.

## Design Decisions

### Ownership model

The config files are **shared** — multiple writers exist (zylos, bootstrap, user manual edits, potentially Codex itself). Zylos is one writer among several, not the sole owner.

Constraint: Codex has no `config set` CLI. File manipulation is the only persistence mechanism. If Codex adds a config API in the future, migrate to it.

### Zylos-managed keys

**Global config** (`~/.codex/config.toml`):
- `openai_base_url` (top-level, **conditionally managed**: zylos sets it when it has a value from opts/env; when zylos has no value, the key is left alone — not deleted — so user-set values survive)
- `[projects."<zylos-dir>"]` section (zylos project trust entry only; other project trust entries are preserved as-is)

**Project config** (`<project>/.codex/config.toml`):
- `check_for_update_on_startup` (top-level)
- `model_availability_nux` (top-level)
- `[features]` → `multi_agent` key only (other feature flags preserved)
- `[notice]` → entire section, zylos full control (**exact replacement**: stale keys deleted, content = exactly zylos's desired set)
- `[notice.model_migrations]` → entire section, zylos full control (**exact replacement**)

Everything outside this list is untouched. Ownership is by **exact section name**, not prefix — e.g. `[notice.experimental]` (if Codex adds it in the future) is NOT zylos-owned and would be preserved.

### File header

Change from `"written by zylos, do not edit manually"` to something that accurately reflects shared ownership, e.g. `"Zylos manages specific keys in this file (marked below). Other settings are preserved across regeneration."`

## Scope

**In scope:**
- `renderCodexProjectConfig()` → accept `existingContent`, merge zylos keys into existing
- `renderCodexGlobalConfig()` → extend merge to preserve non-zylos top-level keys and unknown sections
- `writeCodexConfig()` → pass existing project content to render function
- Update file header comments
- Update existing tests + add merge-preservation tests

**Out of scope:**
- Codex config API integration (doesn't exist yet)
- Changes to callers (`init.js`, `runtime.js`, `self-upgrade.js`) — signatures stay backward-compatible (new `existingContent` param is optional)
- Note: `sync-settings-hooks.js` **does** need an internal change (pass existing content to render for correct drift detection) but no signature change
- TOML library dependency — write a lightweight section/key parser for the simple TOML subset used by Codex config

## Development Checklist

- [ ] Write a TOML merge utility (internal to `runtime-setup.js` or a small helper)
  - Parse TOML content into sections with key-value pairs
  - Support: top-level keys, `[section]` headers, `[section.subsection]` headers, comments, blank lines
  - Merge logic: for each zylos-managed key, set zylos's value; for everything else, preserve existing
  - Section ownership semantics: `full-control` sections (notice, notice.model_migrations) → exact replacement (stale keys removed); `key-level` sections (features) → only specified keys touched; `conditional` keys (openai_base_url) → set when zylos has value, leave alone when it doesn't
  - Section name matching: **exact match only**, not prefix — `[notice]` ≠ `[notice.experimental]`
  - Preserve ordering: existing content order is maintained, zylos keys inserted/updated in-place
- [ ] Refactor `renderCodexProjectConfig(existingContent = '')`
  - When `existingContent` is empty: behave as today (full template generation) for backward compat
  - When `existingContent` is non-empty: merge zylos-managed project keys into existing
  - Update file header comment to reflect shared ownership
- [ ] Refactor `renderCodexGlobalConfig(projectDir, existingContent, opts)`
  - Extend existing preservation logic beyond just `[projects.*]`
  - Preserve all non-zylos top-level keys and unknown sections
  - Update file header comment
- [ ] Update `writeCodexConfig()` to read + pass existing project config content
- [ ] Fix `syncCodexConfig()` drift detection: desired project config must be computed via `renderCodexProjectConfig(existingProject)` (not empty template), so the desired output includes both zylos keys AND preserved external content. Without this, drift detection false-positives on every sync when external keys exist.

## Test Checklist

- [ ] **Merge preserves unknown top-level keys (global)**: existing `model_reasoning_effort = "medium"` survives regeneration
- [ ] **Merge preserves unknown top-level keys (project)**: existing user-added key survives
- [ ] **Merge preserves unknown feature flags (project)**: `[features]` with `fast_mode = false` + zylos's `multi_agent = true` → both present after merge
- [ ] **Merge preserves unknown sections**: e.g. `[profile.fast]` section survives
- [ ] **Zylos keys are always updated**: if user manually changed `check_for_update_on_startup = true`, zylos sets it back to `false`
- [ ] **Empty existing content**: backward compat — same output as today
- [ ] **Existing project trust entries preserved (global)**: regression test for current behavior
- [ ] **Zylos trust entry regenerated (global)**: existing zylos trust with wrong value gets corrected
- [ ] **Comments and blank lines preserved**: existing comments in non-zylos sections survive
- [ ] **syncCodexConfig drift detection — idempotent**: config with external keys → first sync refreshes → second sync with refreshed content returns `changed=false`, external keys still present
- [ ] **syncCodexConfig drift detection — detects real drift**: zylos-managed key manually changed → sync detects drift and refreshes
- [ ] **Stale openai_base_url preserved**: existing `openai_base_url` in global config survives when zylos has no base URL to set (conditional management)
- [ ] **Stale openai_base_url overwritten**: existing `openai_base_url` replaced when zylos has a different value
- [ ] **Stale notice keys deleted**: existing `[notice]` with extra keys → after merge, only zylos's desired keys remain (exact replacement)
- [ ] **Stale notice.model_migrations keys deleted**: same exact replacement behavior
- [ ] **Dotted sibling section preserved**: `[notice.experimental]` or `[notice.some_future_section]` survives merge (not owned by zylos, exact name match only)

## Acceptance Checklist

- [ ] All existing tests pass (`npm test`)
- [ ] New merge tests pass
- [ ] Manual verification: write a config with external keys → run `writeCodexConfig()` → external keys preserved
- [ ] Manual verification: sync hook detects drift correctly
- [ ] No regressions in `zylos init` / `zylos runtime codex` flows
