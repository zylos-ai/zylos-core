# FINAL main sync implementation plan

## 1. Scope and hard boundaries

This plan integrates the frozen Core `main` tip into an independent feature
branch based on the 1.x multi-session Base. The Phase 2 merge direction is
`main` -> feature branch; the resulting Draft PR still targets
`multi-session/base`. This is not authorization to merge the multi-session line
or this PR into `main`.

Frozen inputs:

- `origin/main`: `6655a3814f5efa0fe0675865721f06dee6b32202`
- `origin/multi-session/base`: `f027ac0551183b1785cedd19d187326882e57654`
- Base tree: `e600ce2c74900b9485cdd469249c56949f516548`
- merge-base: `de52f673f7e984abe0e3c6eb497664cd54de0c95`
- `main` after the merge-base: #922 / `4ed63c62` and #921 / `6655a381`

Before Phase 2, fetch both refs again and require all four values above to remain
exact. If either branch has advanced, stop and request a new scope; do not widen
this plan. The implementation branch and PR target remain independent of
`main`; the PR base is `multi-session/base`. After the frozen-value check,
Phase 2 must start the real integration with:

```bash
git merge --no-ff --no-commit 6655a3814f5efa0fe0675865721f06dee6b32202
```

Resolve all seven content conflicts semantically, review the automatically
merged `CHANGELOG.md`, run the scoped checks, and then create the merge commit.
Do not abort the merge merely to replace it with manual copying: the resulting
feature head must have the frozen `main` tip as an ancestor.

The following remain forbidden in this task:

- cherry-picking `main`, or substituting manual copies for the required frozen
  `main` -> feature-branch merge;
- changing `main` or `multi-session/base` directly;
- targeting a PR at `main`;
- merging the feature branch or PR into `main` or `multi-session/base`;
- tagging, releasing, or deploying;
- changing upgrade discovery rules, `scanHistory` behavior, recovery ownership,
  runner/bootstrap behavior, prompt text, or the upgrade bridge;
- resolving current package metadata to 0.9.3, or adding 0.9.3 product behavior
  outside the required historical `CHANGELOG.md` section.

Phase 1 changes only this plan. Product and test changes start only after Luna
explicitly accepts the plan.

## 2. Source commits and semantic disposition

### 2.1 #922 / `4ed63c62`: behavior to port

The contract, not the old implementation shape, is authoritative:

1. Startup attempts automatic recovery with the existing discovery and resume
   rules.
2. If automatic recovery succeeds, startup continues without a recovery prompt.
3. If automatic recovery fails and an unfinished transaction remains, Claude,
   the tmux launcher, and Codex receive the existing recovery prompt.
4. Codex retains its ordinary kick prompt when there is no recovery prompt. A
   non-blocking recovery cue is appended to the kick; a blocking recovery prompt
   replaces it.
5. Codex never concatenates or passes the string `undefined`.
6. With no unfinished transaction, every runtime argv is unchanged.
7. History-only unfinished transactions are detected exactly as before.
8. The implementation does not change detection, recovery eligibility,
   `scanHistory`, prompt wording, bootstrap, maintenance, runner, or bridge
   behavior.

The 0.9.3 commit introduced `resumeUpgradeForStartup()` because that line needed
a resume call followed by a fresh status read. The 1.x Base already performs the
recovery attempt and post-child durable-state decision inside
`discoverUpgradeContext()` through `recoverBeforeUpgrade()`. Port the contract at
the Base launch boundary; do not restore the 0.9.3 bootstrap API or its
`resume/status/scanHistory` option structure.

### 2.2 #921 / `6655a381`: preserve history, not current 0.9.3 metadata

#921 changes `CHANGELOG.md`, `package.json`, and `package-lock.json` for the
0.9.3 release. The complete automatically merged `CHANGELOG.md` history section
must remain in the final tree: it records the released #910/#922 work and the
bridge upgrade path, so removing it would make the historical sequence jump
from 0.9.2 to 1.x.

Historical changelog content is distinct from the current package metadata.
Resolve `package.json` and `package-lock.json` to the Base's current
`1.0.0-beta.1` values and dependency graph; do not leave their root/current
versions at 0.9.3. Do not rewrite the automatically merged 0.9.3 changelog as a
new 1.x release entry, and do not add any other release-note or version work.

## 3. 1.x Base architecture and landing layer

The 1.x launch path differs materially from 0.9.3:

- `SessionAdapter.launch()` is the common Claude/Codex path. It validates the
  target and runtime capability, builds argv with `buildRuntimeArgs()`, writes a
  one-shot shell launcher, and starts the session through `settleLaunch()`.
- `buildRuntimeArgs()` owns the ordinary Codex kick prompt. Claude normally has
  no positional startup prompt.
- `tmux-launcher.js` is a separate deployed/compatibility entry. It already
  discovers recovery before spawning its child.
- `upgrade-context.js` owns transaction-history detection, trusted discovery,
  the actual automatic recovery attempt, post-recovery classification, prompt
  selection, and argv prompt application.
- `skills/comm-bridge/scripts/c4-session-init.js` is a later SessionStart hook,
  not the runtime launch owner. Its local `recoveryContext()` intentionally
  checks only `.zylos/upgrade/active.json` and the stable bootstrap. It does not
  scan `.backup/self-upgrade/<transaction>` when no stable marker exists.

Therefore the #922 behavior lands in the common `SessionAdapter` argv assembly
boundary, using the already-existing discovery and prompt application exported
by `upgrade-context.js`. It does not land in `CodexAdapter` or `ClaudeAdapter`:
doing so would duplicate the same recovery attempt and would bypass future
runtimes using `SessionAdapter`.

### 3.1 Reviewed call-chain gap and ownership decision

The frozen Base proves the following distinction:

1. Direct `discoverUpgradeContext()` already scans transaction history. For a
   transaction-local publication with no stable marker it can run the verified
   transaction recovery closure, re-read durable state, and return an
   active/blocked/recovery-required context with the existing `SYSTEM RECOVERY
   TASK` prompt when recovery fails.
2. The compatibility `tmux-launcher.js` already calls that discovery and applies
   its result before spawning. A runner that exits nonzero while leaving the
   transaction unfinished therefore produces the correct replacement prompt on
   this legacy path, without `undefined`.
3. Actual 1.x Claude and Codex launches do not execute that launcher. Their
   path is `SessionAdapter.launch()` -> `buildRuntimeArgs()` ->
   `writeSessionLaunchScript()` -> `settleLaunch()`, and the generated script
   directly `exec`s the runtime.
4. The C4 SessionStart hook runs too late to own launch argv and, without a
   stable marker, deliberately cannot rediscover a history-only publication.

The missing contract is therefore exactly one call at the common launch owner:
after ordinary argv construction and before launch-script creation,
`SessionAdapter.launch()` must call `discoverUpgradeContext(root)` once and pass
the selected prompt through `applyUpgradePrompt()`. For Codex the prompt index
is the final ordinary kick argument; for Claude it is absent, so the selected
prompt is appended as its only positional startup message.

Do not add transaction scanning to the C4 hook. That would create a second
recovery authority after runtime launch, execute outside the pre-C4 isolation
boundary, and still fail to guarantee the runtime received argv at exec time.
Do not route `SessionAdapter` back through `tmux-launcher.js`; that would revive
the retired JSON/spec launcher architecture and disturb the current shell,
environment, target identity, and settlement contracts.

Expected Phase 2 shape:

- keep `discoverUpgradeContext()` as the single recovery/detection authority;
- reuse the existing `applyUpgradePrompt()` helper; do not add a second helper;
- call discovery exactly once in `SessionAdapter.launch()` after
  `buildRuntimeArgs()` and before `writeSessionLaunchScript()`;
- select `args.length - 1` only for Codex's existing kick prompt and no index for
  Claude;
- apply the prompt after ordinary argv is built but before the launch script is
  written or tmux is created;
- leave `tmux-launcher.js`, `upgrade-context.js`, and `c4-session-init.js`
  unchanged unless a failing contract test first proves an existing helper
  defect and the plan is revised before that product edit.

This is prompt plumbing around an existing recovery mechanism. It adds no new
recovery mechanism, state, environment variable, result field, error code,
file, or persistence contract.

## 4. Conflict-by-conflict target state

The frozen `merge-tree` reports seven content conflicts. They are resolved by
semantic reconstruction, never by choosing an entire side.

| File | Target state | Source of truth | Completion condition |
| --- | --- | --- | --- |
| `cli/lib/runtime/codex.js` | Preserve the Base `SessionAdapter` subclass, trust preflight, and auth flow. Do not reintroduce the 0.9.3 direct `resumeUpgradeForStartup()` call. | Base architecture plus #922 Codex result contract | Codex gets recovery through the common session launch boundary; ordinary kick remains exact; no `undefined` appears. |
| `cli/lib/runtime/tmux-launcher.js` | Resolve the merge conflict to the Base final behavior. It already discovers history-only transactions and applies blocked/non-blocking prompts before spawn; do not route the 1.x adapter through it. | Base launcher plus the independently reproduced nonzero-runner result | The resolved final tree is behaviorally identical to Base for this file; failed recovery remains covered as a compatibility control and no legacy launcher architecture is revived. |
| `cli/lib/runtime/upgrade-context.js` | Resolve the merge conflict to the Base final behavior. Reuse its existing `discoverUpgradeContext()` and `applyUpgradePrompt()` exports exactly; preserve history scan, ownership/controller checks, `recoverBeforeUpgrade()`, closed-recovery wording, stable fallback, cache invalidation, and prompt text. | Base recovery implementation; #922 only supplies the missing consumer | The resolved final tree has no unsupported detection, recovery, result-shape, or prompt-application behavior delta; all existing discovery tests remain valid. |
| `cli/lib/__tests__/runtime-launch.test.js` | Extend the current real `SessionAdapter` + real isolated tmux harness for Claude and Codex. Do not restore 0.9.3 child-process mocks or old adapter APIs. | Base test architecture plus #922 runtime outcomes | Positive failed-recovery cases cover both adapters; success/no-transaction controls prove unchanged argv and exact Codex kick; real product code is exercised. |
| `cli/lib/__tests__/upgrade-startup-context.test.js` | Extend the existing recovery/discovery suite with real deployed bootstrap/maintenance/recovery materials and tmux-launcher coverage. Keep neutral test names. | Base fixture conventions plus #922 discovery/tmux outcomes | Failure, success, history-only, live controller, and no-transaction cases are executable without source rewriting or source re-evaluation. |
| `package.json` | Resolve the merge conflict to Base's current `1.0.0-beta.1` metadata. | Frozen Base; historical 0.9.3 data belongs only in CHANGELOG | Version remains `1.0.0-beta.1`; no dependency/script drift. |
| `package-lock.json` | Resolve the merge conflict so root/current package version remains `1.0.0-beta.1` and the Base dependency graph is retained. | Frozen Base and resolved `package.json` | Lock root name/version match `package.json`; isolated lock-only regeneration produces no diff. |

One additional Base-native file is the sole planned production change:
`cli/lib/runtime/session-adapter.js`, because that is where Claude and Codex now
share final argv assembly. `skills/comm-bridge/scripts/c4-session-init.js` is an
explicit unchanged control: its stable-marker-only behavior remains intentional.
If implementation evidence contradicts this ownership decision, update and
re-review this plan before code; do not silently move the behavior.

## 5. Audit of non-conflicting automatic hunks

The frozen main range changes exactly eight files. Seven are the conflicts
listed above. The only non-conflicting merge result is `CHANGELOG.md`, containing
the complete 0.9.3 history section for #910/#922 and the bridge upgrade path.

Phase 2 must perform the frozen merge and keep that automatic changelog result.
Before delivery:

1. compare `de52f673..origin/main` and confirm the same eight-file set;
2. regenerate `merge-tree` and confirm the same seven conflicts plus the single
   automatic `CHANGELOG.md` result;
3. after the merge, require `git merge-base --is-ancestor 6655a381 HEAD` to
   succeed and inspect `CHANGELOG.md` to confirm the complete historical 0.9.3
   section was preserved exactly once;
4. inspect the entire PR diff and confirm that no 0.9.3 current package
   version, release-branch behavior, or bridge-only product behavior entered;
5. inspect every changed line outside the planned runtime/test files and treat
   any extra file as a blocker requiring plan revision.

## 6. Execution pseudocode

The source comment on every line below names the contract, not a file to copy.

### 6.1 Common SessionAdapter launch (Claude and Codex)

```text
validate target/name/capability → continue or fail before tmux creation // Base SessionAdapter
canonicalize root and build clean env → preserve existing launch isolation // Base SessionAdapter
build ordinary runtime argv → Claude args or Codex args ending in exact kick // Base buildRuntimeArgs
discover upgrade context once → run existing automatic recovery and durable recheck // Base discoverUpgradeContext
context.blocked → replace Codex's final kick, or append a prompt for Claude // Base applyUpgradePrompt
context.active && !context.controllerAlive && context.prompt → append cue to ordinary prompt // #922 contract
otherwise → keep argv byte-for-byte unchanged // #922 no-transaction/success contract
write one-shot shell launcher → no recovery data in env or persistent files // Base SessionAdapter
settle tmux launch → preserve current session identity and cleanup // Base SessionAdapter
```

For Codex, the prompt index is the existing final kick argument. For Claude,
there is no ordinary positional prompt, so a required recovery prompt is appended
as the sole positional startup message. Prompt application must no-op on null or
empty prompt; concatenation never sees `undefined`. Discovery happens before
`writeSessionLaunchScript()`, so both runtimes receive the prompt in the argv
that the one-shot script directly execs.

### 6.2 tmux launcher compatibility path

```text
read and unlink launch spec → preserve current failure semantics // Base tmux launcher
discover upgrade context once → existing automatic recovery and durable recheck // Base discoverUpgradeContext
blocked context → replace indexed ordinary prompt // Base applyUpgradePrompt
active non-controller context with prompt → append to indexed ordinary prompt // #922 contract
success/live controller/no transaction → leave spec.args unchanged // #922 controls
spawn child and forward signals/exit → preserve current behavior // Base tmux launcher
```

This is a regression/control path only. Phase 2 does not edit it and does not
make `SessionAdapter` call it.

### 6.3 Recovery outcomes

```text
history-only candidate found → use current bounded history scan // Base hasTransactionHistory
live recognized controller found → observe; do not run runner; no prompt // Base ownership contract
recoverable interrupted transaction → run frozen verified runner // Base recoverBeforeUpgrade
runner reaches clean terminal state → return inactive; launch normally // Base durable recheck
runner fails or durable state remains unfinished → return existing failure/transaction prompt // #922 observable contract
ambiguous/modified/untrusted materials → return existing blocked prompt // Base security contract
no transaction/material → return inactive; launch normally // Base no-transaction contract
```

## 7. Test and acceptance plan

### 7.1 Fixtures and test rules

- Use the repository's existing neutral test files
  `upgrade-startup-context.test.js` and `runtime-launch.test.js`.
- If a helper must be added, name it for startup recovery behavior, not for
  FINAL, ZYLO, a review round, or a mutation.
- Exercise imported product functions and real launch paths. Do not use
  `vm`, `compileFunction`, `eval`, `new Function`, or runtime source rewriting.
- Build failure fixtures from the real deployed `upgrade-bootstrap.cjs`,
  `upgrade-maintenance.cjs`, and frozen transaction recovery code. Create a
  valid transaction-local publication with no `.zylos/upgrade/active.json` and
  a hash-verified transaction runner that exits `9` while durable unfinished
  state remains. The fixture validates the product's real discovery, runner
  invocation, durable re-read, and launch plumbing; it must not stub
  `discoverUpgradeContext()` or replace imported launch code with re-evaluated
  source. The exit-9 runner is the explicit child-process fault boundary, not a
  replacement for product discovery: publish it through the real transaction
  journal/hashes alongside the real maintenance and installer materials, then
  let the real `recoverBeforeUpgrade()` path invoke and classify it.
- Isolate `HOME`, `PM2_HOME`, `TMPDIR`, `ZYLOS_DIR`, and the tmux socket. Register
  cleanup for transaction directories, launch scripts, sessions, sockets, and
  processes even when an assertion fails.

### 7.2 Required cases

| Case | Claude SessionAdapter | Codex SessionAdapter | tmux launcher | Required result |
| --- | --- | --- | --- | --- |
| automatic recovery fails | positive | positive | positive | Existing recovery prompt reaches runtime; unfinished transaction remains. |
| automatic recovery succeeds | positive | positive | positive | Transaction reaches clean terminal state; no recovery prompt. |
| no transaction | negative | negative | negative | Claude argv unchanged; Codex has exact kick only; tmux argv unchanged. |
| history-only unfinished transaction | positive | positive | positive | Current history scan finds it; same prompt propagation rules apply. |
| live controller | control | control | control | Runner is not executed and no recovery prompt is injected. |
| Codex prompt safety | n/a | positive and negative | where Codex spec is used | Final prompt never contains `undefined`; blocking replaces, non-blocking appends once. |

The decisive positive case must traverse the actual adapter boundary for each
runtime:

```text
transaction-local publication, no stable marker, runner exit 9
  -> SessionAdapter.launch()
  -> real discoverUpgradeContext(root)
  -> real buildRuntimeArgs()/applyUpgradePrompt()
  -> real writeSessionLaunchScript()/settleLaunch()
  -> runtime fixture observes argv
```

Claude must observe the recovery prompt as its sole positional startup message.
Codex must observe that prompt in place of the ordinary sentinel, with neither
the sentinel nor `undefined` retained. A paired no-transaction run must preserve
Claude's argv and Codex's exact sentinel. Direct discovery and
`tmux-launcher.js` cases remain controls; they do not satisfy the adapter-path
acceptance by themselves. The C4 hook is not used to make either assertion.

### 7.3 Frozen-Base baseline comparison

Before editing product code, run the targeted suites on frozen Base and record
outside the repository: command, exit code, pass/skip/fail counts, Base SHA, and
observed argv for no-transaction, live-controller, history-only, and failed
recovery fixtures. After implementation, repeat with fresh fixtures and the same
inputs. Compare the Base `discoverUpgradeContext()` result and prompt text with
the new launch argv result; the only permitted delta is that the already-selected
prompt now reaches the Base runtime launch path after a failed recovery.

Record Luna's reviewed Base baseline separately: the two existing targeted files
currently report 42 tests / 41 pass / 1 macOS skip / 0 fail, exit 0. That baseline
proves existing discovery and compatibility-launcher behavior, but not the new
adapter-path acceptance; the added end-to-end adapter cases must fail on frozen
Base for missing prompt propagation and pass only after the SessionAdapter edit.

This is a before/after black-box comparison. Do not copy or dynamically evaluate
the frozen source inside a test.

### 7.4 Developer-run checks

Run only the task-scoped tests:

```bash
node scripts/run-node-tests.js \
  cli/lib/__tests__/upgrade-startup-context.test.js \
  cli/lib/__tests__/runtime-launch.test.js
```

If the implementation changes a tmux command or transport contract, also run
the changed runtime test file against the locally available tmux binary and
hand the full five-version matrix to Luna. Do not treat one local tmux version
as the release matrix.

Do not run the full Node/Jest suites, unrelated existing e2e tests, mutation
tests, or the complete tmux matrix locally. Luna owns those on DGX. A newly
added task-specific e2e may be run if this plan is revised to name it first.

### 7.5 Structural checks

Check the resolved current versions directly:

```bash
node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  if (pkg.version !== "1.0.0-beta.1" ||
      lock.version !== "1.0.0-beta.1" ||
      lock.packages?.[""]?.version !== "1.0.0-beta.1") process.exit(1);
'
```

Verify package/lock consistency in a disposable clone. Lifecycle scripts are
disabled, and both `HOME` and `ZYLOS_DIR` point inside the disposable directory,
so this command cannot sync skills into the live deployment:

```bash
lockcheck="$(mktemp -d)"
trap 'rm -rf "$lockcheck"' EXIT
git clone --no-local --no-checkout "$(git rev-parse --show-toplevel)" "$lockcheck/repo"
git -C "$lockcheck/repo" checkout --detach HEAD
mkdir -p "$lockcheck/home" "$lockcheck/zylos"
env HOME="$lockcheck/home" ZYLOS_DIR="$lockcheck/zylos" \
  npm --prefix "$lockcheck/repo" install --package-lock-only --ignore-scripts \
  --no-audit --no-fund
git -C "$lockcheck/repo" diff --exit-code -- package.json package-lock.json
```

Then run:

```bash
git diff --check
git diff origin/multi-session/base...HEAD -- \
  CHANGELOG.md docs/dev-plan-final-main-sync.md cli/lib/runtime \
  cli/lib/__tests__ package.json package-lock.json
test "$(git rev-parse origin/main)" = 6655a3814f5efa0fe0675865721f06dee6b32202
test "$(git rev-parse origin/multi-session/base)" = f027ac0551183b1785cedd19d187326882e57654
test "$(git merge-base origin/main origin/multi-session/base)" = de52f673f7e984abe0e3c6eb497664cd54de0c95
git merge-base --is-ancestor 6655a3814f5efa0fe0675865721f06dee6b32202 HEAD
```

Before starting the merge, regenerate the frozen `merge-tree` inventory and
require the same seven conflicts. After resolution, use the full PR diff and
the ancestor check—not a second synthetic merge-tree—as the final proof.

Evidence logs, fixture artifacts, mutation output, and acceptance tables stay
outside the repository and are summarized in the issue/PR delivery text.

## 8. Phase 2 commit and PR boundaries

Phase 1 consists of one plan-only commit and a Draft PR to
`multi-session/base`.

After Luna approves this plan, Phase 2 must merge the frozen `main` tip into the
feature branch, preserve the automatically merged complete 0.9.3 changelog
history, semantically resolve all seven conflicts, and may add only:

- the minimum Base-native discovery and prompt-application call in
  `session-adapter.js`;
- targeted tests in the two existing neutral test files;
- a plan correction commit when review changes this design.

`codex.js`, `tmux-launcher.js`, `upgrade-context.js`, `package.json`, and
`package-lock.json` are conflict-resolution files: they will be touched while
recording the merge, but their final product/current-version semantics must stay
at the Base target state unless Luna identifies evidence that requires a plan
revision before code. `CHANGELOG.md` is the deliberate exception: retain the
automatically merged historical 0.9.3 section. The C4 SessionStart hook remains
unchanged. No new production mechanism is planned.

Do not mix the plan and product implementation into one commit. Do not use a
cherry-pick message. Before Phase 2 delivery, review the entire
`origin/multi-session/base...HEAD` diff, not only the latest commit, and map each
finding to its fix, test, and contract clause.

## 9. Explicitly deferred or out of scope

- deciding whether or when the multi-session line merges into `main`;
- merging this PR;
- a new 1.x version bump or new 1.x changelog release section, tag, release,
  package publication, deployment, or live upgrade; preserving the frozen
  0.9.3 historical changelog is required integration work, not a new release;
- changing macOS recovery eligibility or adding a manual takeover command;
- changing transaction discovery, ownership, controller identity, hash checks,
  recovery prompt copy, runner/bootstrap/maintenance, or upgrade bridge logic;
- full Node/Jest, all existing e2e, mutation, the final PR-to-Base merge trial,
  and the complete tmux compatibility matrix, which belong to Luna's DGX
  acceptance.

## 10. Phase 1 handoff checklist

The plan-review comment must include:

- branch and Draft PR URL;
- exact frozen Base SHA/tree, main SHA, merge-base, and plan head SHA;
- actual diff: this plan file only;
- live-SHA result and seven-conflict inventory;
- unresolved decisions, or an explicit `none`;
- checks run and their exit codes;
- checks intentionally not run: product tests, full suites, e2e, mutation,
  PR-to-Base merge trial, release, and deploy;
- a request for Luna's explicit Phase 2 approval. Until that approval arrives,
  no product or test code is written.
