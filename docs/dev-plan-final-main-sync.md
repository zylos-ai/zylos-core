# FINAL main sync implementation plan

## 1. Scope and hard boundaries

This plan ports the effective behavior of Core `main` pull request #922 into the
1.x multi-session line. It is not a merge of `main` into the multi-session line.

Frozen inputs:

- `origin/main`: `6655a3814f5efa0fe0675865721f06dee6b32202`
- `origin/multi-session/base`: `f027ac0551183b1785cedd19d187326882e57654`
- Base tree: `e600ce2c74900b9485cdd469249c56949f516548`
- merge-base: `de52f673f7e984abe0e3c6eb497664cd54de0c95`
- `main` after the merge-base: #922 / `4ed63c62` and #921 / `6655a381`

Before Phase 2, fetch both refs again and require all four values above to remain
exact. If either branch has advanced, stop and request a new scope; do not widen
this plan. The implementation branch and PR target remain independent of
`main`; the PR base is `multi-session/base`.

The following remain forbidden in this task:

- merging or cherry-picking `main`;
- changing `main` or `multi-session/base` directly;
- targeting a PR at `main`;
- tagging, releasing, deploying, or merging the PR;
- changing upgrade discovery rules, `scanHistory` behavior, recovery ownership,
  runner/bootstrap behavior, prompt text, or the upgrade bridge;
- importing 0.9.3 version or release metadata into the 1.x line.

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

### 2.2 #921 / `6655a381`: release-line metadata not to port

#921 changes only `CHANGELOG.md`, `package.json`, and `package-lock.json` for the
0.9.3 release. Its useful historical fact is that #922 shipped on the 0.9.3
line; this plan and the PR description retain that provenance.

Do not import the 0.9.3 release section, bridge notice, version value, or lockfile
root version. Preserve the Base release history already present in
`CHANGELOG.md` and keep all 1.x package version fields at `1.0.0-beta.1`. The
task explicitly excludes extra version and release-note work.

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

Therefore the #922 behavior lands in the common `SessionAdapter` argv assembly
boundary and the existing `upgrade-context.js` prompt application boundary. It
does not land in `CodexAdapter` or `ClaudeAdapter`: doing so would duplicate the
same recovery attempt and would bypass future runtimes using `SessionAdapter`.

Expected Phase 2 shape:

- keep `discoverUpgradeContext()` as the single recovery/detection authority;
- add at most one small Base-native helper that applies its returned context to
  runtime argv, or perform that application directly in `SessionAdapter` if the
  helper would not remove duplication;
- call discovery once per launch path;
- apply the prompt after ordinary argv is built but before the launch script is
  written or tmux is created;
- use the same application semantics from `tmux-launcher.js` so the compatibility
  path and `SessionAdapter` cannot drift.

This is prompt plumbing around an existing recovery mechanism. It adds no new
recovery mechanism, state, environment variable, result field, error code,
file, or persistence contract.

## 4. Conflict-by-conflict target state

The frozen `merge-tree` reports seven content conflicts. They are resolved by
semantic reconstruction, never by choosing an entire side.

| File | Target state | Source of truth | Completion condition |
| --- | --- | --- | --- |
| `cli/lib/runtime/codex.js` | Preserve the Base `SessionAdapter` subclass, trust preflight, and auth flow. Do not reintroduce the 0.9.3 direct `resumeUpgradeForStartup()` call. | Base architecture plus #922 Codex result contract | Codex gets recovery through the common session launch boundary; ordinary kick remains exact; no `undefined` appears. |
| `cli/lib/runtime/tmux-launcher.js` | Preserve Base process spawning, unlink-before-spawn, signal forwarding, and exit logging. Use the common Base-native prompt application semantics around the existing discovery result. | Base launcher plus #922 tmux result contract | Failed recovery leaves the real prompt in argv; success/no transaction leaves the original argv; recovery is attempted once. |
| `cli/lib/runtime/upgrade-context.js` | Preserve Base history scan, ownership/controller checks, `recoverBeforeUpgrade()`, closed-recovery wording, trusted stable fallback, cache invalidation, and prompt text. Only expose/reuse the minimum prompt-to-argv application needed by both launch paths. | Base recovery implementation; #922 only supplies the observable result | No detection/recovery diff beyond prompt propagation; all existing discovery tests remain valid. |
| `cli/lib/__tests__/runtime-launch.test.js` | Extend the current real `SessionAdapter` + real isolated tmux harness for Claude and Codex. Do not restore 0.9.3 child-process mocks or old adapter APIs. | Base test architecture plus #922 runtime outcomes | Positive failed-recovery cases cover both adapters; success/no-transaction controls prove unchanged argv and exact Codex kick; real product code is exercised. |
| `cli/lib/__tests__/upgrade-startup-context.test.js` | Extend the existing recovery/discovery suite with real deployed bootstrap/maintenance/recovery materials and tmux-launcher coverage. Keep neutral test names. | Base fixture conventions plus #922 discovery/tmux outcomes | Failure, success, history-only, live controller, and no-transaction cases are executable without source rewriting or source re-evaluation. |
| `package.json` | Keep Base unchanged at `1.0.0-beta.1`. | Frozen Base | Version remains `1.0.0-beta.1`; no dependency/script drift. |
| `package-lock.json` | Keep Base root and package version at `1.0.0-beta.1`; retain the Base dependency graph. | Frozen Base and `package.json` | Lock root name/version match `package.json`; lock generation produces no diff. |

One additional Base-native file is expected to change:
`cli/lib/runtime/session-adapter.js`, because that is where Claude and Codex now
share final argv assembly. If implementation evidence shows a smaller existing
common boundary, use it and update this plan before code; do not silently move
the behavior.

## 5. Audit of non-conflicting automatic hunks

The frozen main range changes exactly eight files. Seven are the conflicts
listed above. The only non-conflicting merge result is `CHANGELOG.md`, containing
the 0.9.3 release section and bridge notice.

Phase 2 must not run a merge or cherry-pick, so no automatic hunk should enter
the branch. Before delivery:

1. compare `de52f673..origin/main` and confirm the same eight-file set;
2. regenerate `merge-tree` and confirm the same seven conflicts plus the single
   automatic `CHANGELOG.md` result;
3. inspect the entire PR diff and confirm that no 0.9.3 changelog, package
   version, release branch, or bridge-only behavior entered;
4. inspect every changed line outside the planned runtime/test files and treat
   any extra file as a blocker requiring plan revision.

## 6. Execution pseudocode

The source comment on every line below names the contract, not a file to copy.

### 6.1 Common SessionAdapter launch (Claude and Codex)

```text
validate target/name/capability → continue or fail before tmux creation // Base SessionAdapter
canonicalize root and build clean env → preserve existing launch isolation // Base SessionAdapter
build ordinary runtime argv → Claude args or Codex args ending in exact kick // Base buildRuntimeArgs
discover upgrade context once → run existing automatic recovery and durable recheck // Base discoverUpgradeContext
context.blocked → replace positional prompt, or append a prompt for Claude // Base applyUpgradePrompt
context.active && !context.controllerAlive && context.prompt → append cue to ordinary prompt // #922 contract
otherwise → keep argv byte-for-byte unchanged // #922 no-transaction/success contract
write one-shot shell launcher → no recovery data in env or persistent files // Base SessionAdapter
settle tmux launch → preserve current session identity and cleanup // Base SessionAdapter
```

For Codex, the prompt index is the existing final kick argument. For Claude,
there is no ordinary positional prompt, so a required recovery prompt is appended
as the sole positional startup message. Prompt application must no-op on null or
empty prompt; concatenation never sees `undefined`.

### 6.2 tmux launcher compatibility path

```text
read and unlink launch spec → preserve current failure semantics // Base tmux launcher
discover upgrade context once → existing automatic recovery and durable recheck // Base discoverUpgradeContext
blocked context → replace indexed ordinary prompt // Base applyUpgradePrompt
active non-controller context with prompt → append to indexed ordinary prompt // #922 contract
success/live controller/no transaction → leave spec.args unchanged // #922 controls
spawn child and forward signals/exit → preserve current behavior // Base tmux launcher
```

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
  valid published transaction whose real runner exits/fails while durable
  unfinished state remains; do not replace the product runner with a canned
  fake to obtain the positive result.
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

### 7.3 Frozen-Base baseline comparison

Before editing product code, run the targeted suites on frozen Base and record
outside the repository: command, exit code, pass/skip/fail counts, Base SHA, and
observed argv for no-transaction, live-controller, history-only, and failed
recovery fixtures. After implementation, repeat with fresh fixtures and the same
inputs. Compare the Base `discoverUpgradeContext()` result and prompt text with
the new launch argv result; the only permitted delta is that the already-selected
prompt now reaches the Base runtime launch path after a failed recovery.

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

```text
package.json.version == 1.0.0-beta.1
package-lock.json.version == 1.0.0-beta.1
package-lock.json.packages[""].version == 1.0.0-beta.1
package-lock-only regeneration in an isolated temporary clone → no diff
git diff --check → clean
git diff origin/multi-session/base...HEAD → only planned docs/runtime/tests
git rev-parse origin/main origin/multi-session/base and merge-base → frozen values
merge-tree conflict inventory → unchanged unless Luna explicitly re-scopes
```

Evidence logs, fixture artifacts, mutation output, and acceptance tables stay
outside the repository and are summarized in the issue/PR delivery text.

## 8. Phase 2 commit and PR boundaries

Phase 1 consists of one plan-only commit and a Draft PR to
`multi-session/base`.

After Luna approves this plan, Phase 2 may add only:

- the minimum Base-native prompt plumbing in `upgrade-context.js`,
  `session-adapter.js`, and `tmux-launcher.js`;
- targeted tests in the two existing neutral test files;
- a plan correction commit when review changes this design.

`codex.js`, `package.json`, `package-lock.json`, and `CHANGELOG.md` are expected
to remain at the Base target state unless Luna identifies evidence that requires
a plan revision before code. No new production mechanism is planned.

Do not mix the plan and product implementation into one commit. Do not use a
cherry-pick message. Before Phase 2 delivery, review the entire
`origin/multi-session/base...HEAD` diff, not only the latest commit, and map each
finding to its fix, test, and contract clause.

## 9. Explicitly deferred or out of scope

- deciding whether or when the multi-session line merges into `main`;
- merging this PR;
- version bump, changelog release section, tag, release, package publication,
  deployment, or live upgrade;
- changing macOS recovery eligibility or adding a manual takeover command;
- changing transaction discovery, ownership, controller identity, hash checks,
  recovery prompt copy, runner/bootstrap/maintenance, or upgrade bridge logic;
- full Node/Jest, all existing e2e, mutation, final merge trial, and the complete
  tmux compatibility matrix, which belong to Luna's DGX acceptance.

## 10. Phase 1 handoff checklist

The plan-review comment must include:

- branch and Draft PR URL;
- exact frozen Base SHA/tree, main SHA, merge-base, and plan head SHA;
- actual diff: this plan file only;
- live-SHA result and seven-conflict inventory;
- unresolved decisions, or an explicit `none`;
- checks run and their exit codes;
- checks intentionally not run: product tests, full suites, e2e, mutation,
  merge trial, release, and deploy;
- a request for Luna's explicit Phase 2 approval. Until that approval arrives,
  no product or test code is written.
