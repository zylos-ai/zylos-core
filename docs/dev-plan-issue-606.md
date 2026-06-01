# Dev Plan: writeCodexConfig() Merge Instead of Overwrite (#606)

## Summary

`writeCodexConfig()` treats Codex config files as zylos-owned and regenerates them from templates, destroying settings written by bootstrap, users, or Codex itself. Fix by establishing a shared-ownership model: zylos declares which keys it manages, merges only those keys, and preserves everything else.

## Design Decisions

### Ownership model

The config files are **shared** — multiple writers exist (zylos, bootstrap, user manual edits, potentially Codex itself). Zylos is one writer among several, not the sole owner.

Constraint: Codex has no `config set` CLI. File manipulation is the only persistence mechanism. If Codex adds a config API in the future, migrate to it.

### Zylos-managed keys

**Global config** (`~/.codex/config.toml`):
- `openai_base_url` (top-level)
- `[projects."<zylos-dir>"]` section (zylos project trust entry only; other project trust entries are preserved as-is)

**Project config** (`<project>/.codex/config.toml`):
- `check_for_update_on_startup` (top-level)
- `model_availability_nux` (top-level)
- `[features]` → `multi_agent` key only (other feature flags preserved)
- `[notice]` → entire section, zylos full control
- `[notice.model_migrations]` → entire section, zylos full control

Everything outside this list is untouched.

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
- Changes to callers (`init.js`, `runtime.js`, `self-upgrade.js`, `sync-settings-hooks.js`) — signatures stay backward-compatible (new `existingContent` param is optional)
- TOML library dependency — write a lightweight section/key parser for the simple TOML subset used by Codex config

## Development Checklist

- [ ] Write a TOML merge utility (internal to `runtime-setup.js` or a small helper)
  - Parse TOML content into sections with key-value pairs
  - Support: top-level keys, `[section]` headers, `[section.subsection]` headers, comments, blank lines
  - Merge logic: for each zylos-managed key, set zylos's value; for everything else, preserve existing
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
- [ ] Update `syncCodexConfig()` drift detection — verify it still works correctly with merge output (should be fine since it uses exact string comparison)

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
- [ ] **syncCodexConfig drift detection**: no false positives or negatives after refactor

## Acceptance Checklist

- [ ] All existing tests pass (`npm test`)
- [ ] New merge tests pass
- [ ] Manual verification: write a config with external keys → run `writeCodexConfig()` → external keys preserved
- [ ] Manual verification: sync hook detects drift correctly
- [ ] No regressions in `zylos init` / `zylos runtime codex` flows
