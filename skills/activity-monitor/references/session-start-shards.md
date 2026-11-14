# Session-start context for components (shards.d)

Keep startup context fast and local:

1. **Core waits 5.5 seconds for each emitter.** This fixed limit includes loading
   its module. A declaration has no time-budget field and cannot extend it.
2. **A slow emitter affects the whole startup chain.** It can delay the first
   message, and later context or the startup prompt can pass it when their waits
   expire. Putting a slow loader in a shard does not make startup asynchronous.
3. **Fetch in the background; emit from a local cache.** Refresh through the
   component's service, scheduled work, or a session-end refresh. The emitter
   should only read a small local file and return immediately. If the cache is
   missing or stale, return an explicit instruction instead of waiting silently.

This reference describes the current `multi-session/prerelease` branch
(`1.0.0-beta.9`). Core 0.9.6 also supports `shards.d`, but its migration and
hook synchronization behavior differs; consult its version of the documentation.
Both Claude and Codex generate the shard chain; context attachment order differs
as described below.
A shard is startup context, not a place to perform network setup, authentication,
package installation, or a large remote rules fetch.

## Declare a shard

Install the emitter with your component under
`~/zylos/.claude/skills/<component>/`. Write your component's declaration to
`~/zylos/.zylos/shards.d/<name>.json` (or the equivalent beneath `ZYLOS_DIR`):

```json
{
  "name": "example-rules",
  "order": 10,
  "emitter": "skills/example/emit-start-context.mjs",
  "budget": { "maxChars": 10000, "maxTokens": 2200 }
}
```

| Field | Meaning |
| --- | --- |
| `name` | Unique, 1–32 characters, matching `[a-z0-9][a-z0-9_-]{0,31}`. Core names, `fg`, and `start-prompt` are reserved. |
| `order` | Integer at least 10. Component shards sort by this number, then by name. It is an ordering key, not a wait in seconds or a chain position. |
| `emitter` | Module path beneath the installation's `.claude` directory. Relative paths start there; absolute paths must also resolve there. `~` is not expanded in JSON paths. |
| `budget` | Optional output limits; defaults are 10,000 characters and 2,200 estimated tokens. Choose positive integer values at or below both defaults. Larger values are clamped, not a way to increase the caps. This field controls output size, not time. |

The emitter module must export `emit(payload)` or a default function. It receives
that runtime hook's JSON payload and returns text (or a promise of text); null or
undefined means an empty body. Return context rather than printing it yourself:
Core adds the numbered header, applies the output budget, and writes stdout.
Use stderr for diagnostics.

Path validation checks resolved path strings, not symlink targets; do not use
symlinks to place emitter code outside `.claude`.
Invalid or duplicate declarations are skipped. After successful synchronization,
check that the generated runtime hooks (`.claude/settings.json` for Claude,
`.codex/hooks.json` for Codex, beneath `ZYLOS_DIR`) contain `--shard <name>`;
if absent, the declaration was not accepted. The synchronizer (including
`--dry-run`) does not print declaration warnings. For rejection reasons, inspect
the session-start hook's stderr rather than the sync command's output.

Output limits include the section header and any notices. Oversize output is
trimmed to fit both limits, with a path to the full spilled section. Token counts
are estimates, not the runtime's exact tokenizer. Keep context comfortably below
the caps; the budget is not a target size.

## Install, update, and remove

The component owns its declaration. Create or update only its file from an
idempotent `post-install`/`post-upgrade` hook; remove that file in `pre-uninstall`
while the component code is still available. After each change, run the installed
Core's hook synchronizer. `zylos add` and component uninstall do not automatically
register or remove a component's shard declaration for it.

When switching from a legacy SessionStart hook to a shard, the component must
remove its own legacy command in `post-upgrade` from **both** runtime files:
`.claude/settings.json` and `.codex/hooks.json` beneath `ZYLOS_DIR`, regardless
of which runtime is active. Back up those files through the component's upgrade
backup before changing them. Match only the exact command the component installed;
keep unrelated commands, matcher groups, group metadata, and other events.
For example, this idempotent component-owned migration leaves missing files
alone, writes only changed files, and fails on unreadable or invalid JSON:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
// Use the exact command this component previously installed, including quoting.
const legacyCommand = `node "${path.join(root, '.claude/skills/example/legacy-start-hook.js')}"`;

for (const relative of ['.claude/settings.json', '.codex/hooks.json']) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) continue;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(config.hooks?.SessionStart)) continue;
  let changed = false;
  config.hooks.SessionStart = config.hooks.SessionStart.map(group => {
    if (!Array.isArray(group?.hooks)) return group;
    const hooks = group.hooks.filter(hook =>
      !(hook?.type === 'command' && hook.command === legacyCommand));
    if (hooks.length === group.hooks.length) return group;
    changed = true;
    return { ...group, hooks };
  });
  if (changed) fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}
```

Replace the example command with the component's actual historical command.
If the runtimes used different commands, match each file's exact old command
separately; do not broaden the match to a path substring or an entire group.
Run hook synchronization **after** this cleanup and the declaration update.

Use the **actual installed Core package path**, not a guessed copy beneath
`.claude/skills`. For example, replace both absolute paths here with the intended
installation:

```sh
ZYLOS_DIR=/absolute/path/to/zylos node /absolute/path/to/installed-core/cli/lib/sync-settings-hooks.js --dry-run
ZYLOS_DIR=/absolute/path/to/zylos node /absolute/path/to/installed-core/cli/lib/sync-settings-hooks.js
```

`sync-settings-hooks.js` delegates to `sync-runtime-hooks.js`. The exported
`syncRuntimeHooks({ zylosDir })` is the file-writing API for Claude settings and
Codex hooks/config; `syncHooks` alone only reconciles an in-memory Claude object.
After changed settings and outside `--dry-run`, the CLI also calls
`enqueueRestartIfNeeded`: in multi-session mode it can submit a Supervisor
`restart_all`; in single-session mode it queues an idle-time `/exit` through
c4-control. **Both modes can restart the agent**, including when a component
lifecycle hook invokes this CLI. Calling the exported file-writing API directly
does not perform that restart step. Codex loads changed hooks on a new launch.
Integrate synchronization with your component lifecycle; limit direct runtime
hook edits to the component-owned legacy-command migration above.

Synchronization generates the named shard commands and preserves component
and user hooks outside the ordered chain on both runtimes. Core does not remove
a component's legacy hook. Old declarations containing `claimHooks` remain valid
if otherwise well formed: Core ignores that obsolete field and records a warning
that it no longer has any effect and the component must remove its own old hook.
The warning appears on session-start hook stderr, as described above. Removing
a declaration does not recreate its old legacy hook; restore one explicitly only if that is
the intended component behavior.

Check lifecycle output and the generated runtime hooks for `--shard <name>`;
inspect session-start hook stderr for declaration rejection reasons. Core treats
post-install/post-upgrade/pre-uninstall hook failures as nonfatal to the component
operation, so an apparently successful add/upgrade/remove is not proof that the
shard change or synchronization succeeded.

## Understand the startup clock

Claude runtime hooks can run in parallel and attach context in completion order.
Codex attaches hook output in configuration order, with generated shard commands
kept in chain order. Core also uses per-session completion flags on both runtimes
to coordinate the shard chain. A flag is written when that shard's hook process
exits, after its stdout has been written.

For content shard **k** (1-based position), the predecessor wait lasts at most
`(k - 1) × T_LINK`, then the emitter is given its separate 5,500 ms wait budget.
`T_LINK` defaults to 1,000 ms; `ZYLOS_SHARD_T_LINK_MS` changes the link wait only,
not the emitter budget. Numeric `order` values and gaps do not add wait slots.
The current chain has four Core content shards, so the first component is
position 5 and can wait 4 seconds if its predecessor is absent.

If the predecessor is not ready, the header reports the actual elapsed wait:

```text
predecessor "c4-conversations" not ready after 4000ms, continued
```

Core then continues without that predecessor. Waits are bounded, so a slow shard
can be overtaken; do not rely on ordering after a timeout.

The `start-prompt` step waits for the chain tail's completion flag, for at most
`content shard count × T_LINK`, then runs the normal startup-prompt action even
if the flag never appeared. Its wait is concurrent with the content hooks, not
an extra wait that starts after every emitter has finished. With one component,
that tail wait is up to 5 seconds. A slow component can therefore delay prompt
dispatch or still be missing when the prompt proceeds. Compact triggers skip
this startup-prompt step.

## A timeout stops waiting, not the loader

When an asynchronous emitter exceeds the fixed budget, Core injects a visible
failure section instead of its late result. For example:

```text
=== ROLE-EXPERIMENT UNAVAILABLE ===
session-start shard "role-experiment" timed out: role-experiment timed out after 5500ms
=== END ROLE-EXPERIMENT UNAVAILABLE ===
```

The timeout races a promise; it does not abort a request, cancel a timer, or kill
a subprocess. Referenced work left behind can keep the hook process alive, with
its completion flag still absent. Synchronous blocking JavaScript can also
delay the timeout callback. A synchronously blocking emitter is not interrupted
by this timeout; its returned value can win the race after the nominal budget.
This is a fixed await budget, not CPU preemption.

For example, after a missing-predecessor wait of about 4 seconds, an emitter
that starts an 8-second timer can produce the timeout section around 9.5 seconds
but exit and write its flag only around 12 seconds. Its eventual return value is
discarded. These are illustrative timings, not exact scheduling guarantees.
The CLI's 17-second backstop is cleared when the awaited shard function returns;
it is **not** a promise that leftover work may run safely until 17 seconds or
that the process will exit then. Runtime hook deadlines are another outer limit,
not a component-controlled extension of the emitter budget.

## Read a local cache

Store the cache in the component data directory, not in disposable installed
code. Let the background refresher replace it atomically after a successful
fetch. Decide the freshness policy in the component; Core does not refresh it.
For example, this emitter accepts a five-minute cache and otherwise gives the
agent a clear next step:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function emit() {
  const root = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  const cache = path.join(root, 'components', 'example', 'startup-context.json');
  const refresh = path.join(root, '.claude', 'skills', 'example', 'refresh-start-context.mjs');
  const unavailable = `Rules cache is missing or stale. Run node ${JSON.stringify(refresh)} before using these rules.`;
  try {
    const { updatedAt, text } = JSON.parse(fs.readFileSync(cache, 'utf8'));
    const age = Date.now() - updatedAt;
    if (!Number.isFinite(updatedAt) || age < 0 || age > 300_000 || typeof text !== 'string') {
      return unavailable;
    }
    return text;
  } catch {
    return unavailable;
  }
}
```

The example component must implement `refresh-start-context.mjs`; document its
actual refresh command in the component's own instructions.
Keep cache reads small and bounded. Do not fall back to fetching the remote
source inside `emit`: a missing cache should be obvious context, not another
slow startup attempt.
