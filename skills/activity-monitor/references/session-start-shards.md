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

These are the current Core rules, shared by the Claude and Codex hook generators.
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
  "budget": { "maxChars": 10000, "maxTokens": 2200 },
  "claimHooks": ["skills/example/legacy-start-hook.sh"]
}
```

Omit `claimHooks` when there is no legacy hook to replace.

| Field | Meaning |
| --- | --- |
| `name` | Unique, 1–32 characters, matching `[a-z0-9][a-z0-9_-]{0,31}`. Core names, `fg`, and `start-prompt` are reserved. |
| `order` | Integer at least 10. Component shards sort by this number, then by name. It is an ordering key, not a wait in seconds or a chain position. |
| `emitter` | Module path beneath the installation's `.claude` directory. Relative paths start there; absolute paths must also resolve there. `~` is not expanded in JSON paths. |
| `budget` | Optional output limits; defaults are 10,000 characters and 2,200 estimated tokens. Choose positive integer values at or below both defaults. Larger values are clamped, not a way to increase the caps. This field controls output size, not time. |
| `claimHooks` | Optional relative paths to **your component's own** legacy SessionStart hooks. Do not claim user hooks or another component's hooks. Entries cannot be absolute, start with `~`, or contain `..` segments. |

The emitter module must export `emit(payload)` or a default function. It receives
that runtime hook's JSON payload and returns text (or a promise of text); null or
undefined means an empty body. Return context rather than printing it yourself:
Core adds the numbered header, applies the output budget, and writes stdout.
Use stderr for diagnostics.

Path validation checks resolved path strings, not symlink targets; do not use
symlinks to place emitter code outside `.claude`. `claimHooks` ownership is the
component author's responsibility, not something the registry can infer.
Invalid or duplicate declarations are skipped with warnings, so verify the
result rather than assuming a file's presence means it was accepted.

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
The CLI also calls `enqueueRestartIfNeeded` after changed settings, which can
submit a Supervisor `restart_all` in multi-session mode. Calling the exported
file-writing API directly does not perform that restart step. Codex loads changed
hooks on a new launch. Integrate synchronization with your component lifecycle
rather than editing runtime hook files by hand.

Synchronization generates the named shard commands and removes declared legacy
hook commands to avoid duplicate injection. Undeclared component and user hooks
are preserved and remain outside the ordered chain. Removing a declaration does
not recreate its old legacy hook; restore one explicitly only if that is the
intended component behavior.

Check lifecycle output, declaration warnings, and the generated runtime hooks.
Core treats post-install/pre-uninstall hook failures as nonfatal to the component
operation, so an apparently successful add/remove is not proof that the shard
change or synchronization succeeded.

## Understand the startup clock

Runtime hooks can run in parallel and attach their context in completion order.
Core uses per-session completion flags to keep shards in chain order. A flag is
written when that shard's hook process exits, after its stdout has been written.

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
delay the timeout callback: this is a fixed await budget, not CPU preemption.

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
