# Settings Hook Migration Fix

## Problem Confirmation

Latest `main` at `330dd9e` contains a reproducible migration gap for
`~/zylos/.claude/settings.json`.

The current template adds `session-foreground.js` to each `SessionStart`
matcher group. A user upgrading from `v0.4.13` already has the
`startup`, `clear`, and `compact` matcher groups, but those groups do not
contain `session-foreground.js`.

Current `syncHooks()` aligns by matcher group and, when a group already
exists, only updates hooks that are already present. It does not add newly
introduced core hooks into that existing matcher group. Reproducing with
the real `v0.4.13` template as installed settings and current `main` as
the desired template produced:

```json
{
  "result": { "added": 1, "updated": 0, "removed": 0 },
  "foregroundMissing": ["startup", "clear", "compact"],
  "postToolUseFailureAdded": true
}
```

This confirms that the new `PostToolUseFailure` event is added because the
event group is missing, while `session-foreground.js` is skipped because
the containing `SessionStart` matcher groups already exist.

## Root Cause

The matcher-aware forward pass was introduced to avoid an older bug where
hooks were matched across all matcher groups, causing missing groups such
as `clear` and `compact` to be skipped. That fix intentionally stopped
adding hooks to an existing matcher group to respect user config.

That rule is too broad for template-owned Zylos core hooks. It treats a
normal older Zylos matcher group as fully user-owned, so new core hooks in
the same matcher group never migrate.

The legacy self-upgrade fallback path has a related weakness:
`generateMigrationHints()` still detects missing hooks by script path
across the whole event instead of within the matching matcher group.

## Requirements

- Do not overwrite the whole user `settings.json`.
- Preserve user top-level settings such as `model`,
  `autoMemoryEnabled`, and `autoDreamEnabled` when already configured.
- Preserve user custom hooks and hook ordering.
- Add missing Zylos core hooks from the current template to the matching
  event and matcher group.
- Avoid duplicate core hooks by comparing normalized script paths.
- Continue updating existing template-managed hooks when their command or
  timeout changes.
- Continue removing obsolete Zylos core hooks only when they belong to a
  core skill present in the template-owned skill set.

## Fix Design

1. Change `syncHooks()` forward pass from group-level all-or-nothing sync
   to per-hook sync inside the matching matcher group.
2. If the matcher group does not exist, add the whole template group as it
   does today.
3. If the matcher group exists:
   - find existing command hooks by normalized script path within that
     group;
   - update command and timeout drift for existing template hooks;
   - append missing template hooks to that same group;
   - leave all unrelated user hooks untouched.
4. Keep the matcher-aware reverse pass, so obsolete core hooks are removed
   only from the corresponding matcher group.
5. Update `generateMigrationHints()` fallback to detect missing and
   modified hooks in the corresponding matcher group rather than anywhere
   in the event.
6. Add regression tests using real historical templates where possible:
   - `v0.4.13` settings upgraded to current template gains
     `session-foreground.js` in `startup`, `clear`, and `compact`;
   - `PostToolUseFailure` is still added;
   - user custom hooks in the same group are preserved;
   - dry-run does not mutate installed settings;
   - fallback migration hints include per-matcher missing hooks.

## Design Review

### User Customization Safety

The migration still writes a merged JSON document, not the template as a
whole. Existing user top-level settings are already guarded by
`Object.hasOwn()` checks and remain unchanged. User hook entries that are
not matched by template script paths are not edited or removed.

### Core Hook Ownership

Zylos core hooks are operational infrastructure. Missing core hooks can
break activity tracking, startup state, or restart behavior. The sync
should therefore treat template core hooks as managed entries and ensure
they are present, while still preserving user-added hooks around them.

### Regression Against Matcher-Aware Sync

The previous matcher-aware fix remains important: matching across all
groups would still be wrong because it can skip required `clear` or
`compact` groups when `startup` already contains the same scripts. This
fix keeps matcher alignment but changes the behavior within a matched
group from "update only" to "update or append missing template hooks".

### Duplicate Avoidance

All comparisons use `extractScriptPath()`, so command wrappers and `~/`
normalization continue to avoid duplicate entries for the same underlying
script.

### Fallback Path

Normal self-upgrade shells out to the newly installed
`sync-settings-hooks.js`, but the fallback `generateMigrationHints()` path
should still be correct for bootstrap failures. Updating both paths avoids
two different migration semantics.

## Implementation Notes

The implementation should stay narrowly scoped to:

- `cli/lib/sync-settings-hooks.js`
- `cli/lib/self-upgrade.js`
- `cli/lib/__tests__/sync-settings-hooks.test.js`
- `cli/lib/__tests__/self-upgrade.test.js`

No template changes are required.
