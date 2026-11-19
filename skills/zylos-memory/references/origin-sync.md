# Origin Sync procedure

Read [common safety and reading rules](sync-common.md) and [writing rules](sync-writing.md) completely, then execute only the Origin procedure below.

## Origin Sync

Select this procedure only when the control prompt names `Origin Sync`;
use `zylos-origin-sync` in Claude. Being in origin does not select this job.
This is a separate job from the origin group's working-state Sync. It only
runs in the origin session, uses kind=origin. Its only sync-files operation is
the read-only `list --group G` below; never run group cleanup/rotate/commit.

1. Acquire, then read `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js origin-sync backlog --json`. No candidates means
   release and return. Process oldest bookmarks first. The raw-row budget is the
   Origin budget resolved above; checkpoint summaries do not consume it. Create
   this run's private export directory as in the common rules.
2. Each command block runs in a new shell. At the start of **every** block,
   replace the assignment placeholders with literal values: this run's private
   directory from `mktemp -d`, the token from acquire, candidate G, and its
   run-local counter n. Do not rely on variables set by an earlier tool call.
   Save command JSON stdout directly to metadata files in that directory;
   never transcribe receipts, list objects, or hashes into a submission. These
   files share the private directory's existing cleanup rule. Export summaries:

   ```bash
   set -o pipefail
   exportDir='<private directory from mktemp -d>'
   T='<token from acquire>'
   G='<candidate group>'
   n='<run-local counter for G>'
   node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --origin-sync --group "$G" --summaries-only --out "$exportDir/$n-summaries" | tee "$exportDir/$n-summaries-meta.json"
   ```

   Use the metadata JSON printed by the command (also saved for submission);
   do not read the metadata file separately: the absolute `path`, `count`, `firstId`,
   `lastId`, `bytes`, `sha256`, and summary `receipt`
   `{"scope":...,"after":...,"end":...,"coverageEnd":...,"count":...,"sha256":...}`.
   Keep the metadata file unchanged; C is its receipt’s `coverageEnd`. Read the whole file at
   the returned path by the byte-range rule above (8192-byte ranges with a
   four-byte overlap), including when it is one long JSON line. A truncated range
   is unread: use the bounded read retries above. If that group's export or read
   fails after applicable read/corrected-call retries,
   skip its merge and cursor advance, record why, and continue other groups
   under the common failure rules. The immediate-stop token rule applies.
3. If budget remains, also fill `remaining` with its literal value and run:

   ```bash
   set -o pipefail
   exportDir='<private directory from mktemp -d>'
   T='<token from acquire>'
   G='<candidate group>'
   n='<run-local counter for G>'
   remaining='<remaining raw-row budget>'
   C=$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).receipt.coverageEnd)' "$exportDir/$n-summaries-meta.json")
   node ~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --origin-sync --group "$G" --raw-only --after "$C" --limit "$remaining" --out "$exportDir/$n-raw" | tee "$exportDir/$n-raw-meta.json"
   ```

   Use the printed metadata without a separate metadata-file read. Deduct its
   `count`, retain its raw `receipt`
   (`scope`, `after`, `end`, `count`, `sha256`) unchanged in that file, and read the whole
   file the same way. A limited read's receipt ends at its last returned row;
   the cursor cannot move past it. If this export or read fails after the bounded
   read retries or applicable corrected-call retries under the common rules,
   neither cursor for G advances. With budget exhausted, skip the raw export;
   no raw metadata file is created, so the generated raw receipt is then `null`.
   Use the same G and n literals for this group's later list and advance.
4. For each group actually processed, save the complete read-only list result:

   ```bash
   set -o pipefail
   exportDir='<private directory from mktemp -d>'
   T='<token from acquire>'
   G='<candidate group>'
   n='<run-local counter for G>'
   node ~/zylos/.claude/skills/zylos-memory/scripts/sync-files.js list --group "$G" | tee "$exportDir/$n-inputs.json"
   ```

   Use the printed object as that group's `inputs` (also saved for submission);
   do not read the metadata file separately. The script
   chooses the first log date from G's Origin cursor update (the latest seven
   calendar days when there is no cursor), in the configured timezone. Read each
   returned `sessions[].path` in full. It returns only scope and sessions for
   `--group`; it never reads candidate state or inbox. No export, group or log
   paths or globs may be constructed by the worker.
   Failed required logs prevent that
   group's merge/advance. For projects and decisions, read the complete category
   `INDEX.md` first (a missing INDEX is an empty table), then read only the
   relevant pages in full. If unmatched, Grep that category including `archive/`,
   then follow "Moving from old files" below before creating a page. Other
   shared files are read as before. Deduplicate facts and associate each
   necessary edit with its input groups.
5. Apply necessary shared edits through `edit_memory`, limited to identity,
   references, reference/** and users/**. Use a unique expected fragment, or
   create a missing file. Projects and decisions are written only to pages in
   their new directories, never to old files or `legacy/`. Update the page's
   `Status`/`Updated` header and append dated progress, then run
   `node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js rebuild`. On `LEGACY_READ_ONLY`, redirect the edit to
   the corresponding page; this does not fail the step. Report a rebuild
   failure without blocking cursor advancement. Use the common corrected-call
   retry rule for necessary edits. A group
   with unfinished necessary edits cannot advance; if several depend on one
   failed shared edit, all those groups remain unadvanced. Partial committed
   files stay; there is no cross-file rollback.
6. For a substantive identity change already written, call
   `node ~/zylos/.claude/skills/zylos-memory/scripts/request-rotation.js --reason identity`. Report TRANSITION_OPEN or enqueue
   failure as rotation incomplete; it does not undo the identity write or
   block successful groups' cursor advancement. Do not promise an automatic retry.
7. Before any cursor advance or checkpoint, run the read-only
   `node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js check-navigation`. Its JSON contains
   `navigation: {count, locations}` for references.md old-path navigation and
   `headings: {count, locations}` for old-heading pointers; each location has
   `path`, `line`, and `text`. The checker reads shared identity/references,
   reference pages (including archived pages), and user profiles. It skips
   legacy sources, the old monolithic files, generated indexes, and working
   histories. In fields starting with `- **Moved from:** `, old-file names followed
   by straight- or curly-quoted titles are excluded, including multiple titles
   and titles with parenthetical notes. Any old-file references remaining in the
   field still count, as do references in prose. Heading-pointer candidates conservatively include plain old-file
   references as well as anchors and file:line references; inspect the reported
   lines before choosing a replacement.
   Use the corresponding count to decide whether
   item 2 or 4 needs manual inspection. A zero count means report "no action
   needed" for that item and skip its manual inspection. If the check fails,
   report it and inspect both items manually; do not assume a zero count.
   Execute items 1 and 3 every run, including on the first Sync with no pages.
   Check shared file content as part of the audit. Run
   `node ~/zylos/.claude/skills/zylos-memory/scripts/memory-status.js` to measure
   `identity.md` and `references.md` against both startup character and estimated-token
   limits; do not infer their status from byte sizes. In the Sync report, explicitly
   list either file reported as `WARN` or `OVER`, including its reported character
   and estimated-token usage. If both files are `OK`, state that both are within
   the warning thresholds. Report any missing file or command failure instead of
   assuming the files fit. This is an audit result, not an extra owner/system alert, and does
   not block writes. In the Sync report, write one result sentence
   for each item: what was done, why no action was needed, or what failed.
   1. Run `node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js rebuild`.
   2. When `navigation.count` is nonzero, inspect the reported locations.
      Only after rebuild succeeds and both category INDEX files exist, replace
      references.md navigation that still names the old files as read/write
      locations with `reference/projects/INDEX.md` and
      `reference/decisions/INDEX.md`. Otherwise report why navigation was not changed.
      Include navigation lines that still refer to the old paths, even if they
      describe those files as read-only history.
   3. Apply the archive/restore rule below: archive eligible completed or abandoned
      pages, and restore archived pages mentioned again. Check every INDEX row
      whose Status is completed/abandoned and Updated is about 30 days old or
      older; archive every eligible row. Report if none qualify.
   4. When `headings.count` is nonzero, inspect the reported locations.
      Once old files have moved into `reference/legacy/`, replace pointers to old
      headings with the matching page or, if no page exists, the legacy archive
      file, including navigation lines that still refer to the old paths.
      Report if there are no such pointers or the old files remain in place.

   Audit errors follow the common retry/report-only rules and do not block
   advancement. The immediate-stop token rule applies. For each successful group,
   generate advance stdin from that group's saved files:

   ```bash
   exportDir='<private directory from mktemp -d>'
   T='<token from acquire>'
   G='<candidate group>'
   n='<run-local counter for G>'
   node --input-type=module - "$exportDir/$n-summaries-meta.json" "$exportDir/$n-raw-meta.json" "$exportDir/$n-inputs.json" <<'NODE' | node ~/zylos/.claude/skills/zylos-memory/scripts/origin-cursor.js advance --group "$G" --token "$T"
   import fs from 'node:fs';
   const [summaryPath, rawPath, inputsPath] = process.argv.slice(2);
   const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
   process.stdout.write(JSON.stringify({
     summary: read(summaryPath).receipt,
     raw: fs.existsSync(rawPath) ? read(rawPath).receipt : null,
     inputs: read(inputsPath),
   }));
   NODE
   ```

   The script recomputes both receipts from the
   database and the session-log list, then sets the summary cursor to the
   summary receipt's `end` and the raw cursor to the raw receipt's `end`; without
   a raw receipt, new summaries move the raw cursor to max(S,min(C,upTo)) and no
   new summary means no advance. Never supply cursor numbers. A missing or
   malformed `--token` is the call error in the common rules. Any other
   rejection leaves both cursors for that group unchanged. Correct call errors
   only under the common per-step retry limit; after those retries, report the
   rejection and continue eligible groups under the common failure rules.
   `INPUT_CHANGED` receives no retry and stops later writes under the common
   terminal-input rule. Never replace a saved receipt to force advancement.
8. Cross-group correlation prompts. Prompt only **strong** correlations: both
   groups' records point to the same task, the same object, or the same person's
   same matter (including commitments that contradict each other). A similar
   topic is not enough. At most three prompts per run.
   - **Once per correlation.** Before prompting, Grep the relevant project
     pages in `reference/projects/` (including `archive/`) and the old file or
     `reference/legacy/` for the matching record. Each correlation is recorded
     at the end of its related project page as
     `Correlation between groups A and B notified at <time>`; a correlation
     already recorded is not prompted again unless something new has happened
     (for example a new conflict). Do not keep a separate table or file of sent
     prompts. If no project page fits, create an ordinary project page with
     both group names in `Keys`; when created only for this correlation record,
     set `Status: completed` and archive it later by the normal rule.
   - **Order.** Write that record as part of the necessary shared edits
     **before** cursor advance; send only after those writes/advances, via
     `node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js internal G` with stdin.
   - **Fixed format.** Each recipient group gets exactly this text, with the
     placeholders filled in (one sentence each) and nothing else:
     ```
     [Correlation notice] Your "<this group's matter, one sentence>" relates to "<the other group's matter, one sentence>" in <other session group>: <why, one sentence>. Pointer: <C4 #id, checkpoint #id, or sessions/<date>.md>. For details, ask that group directly (node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js internal "<other group>"); no need to reply to this message.
     ```
     Pointers only, never raw logs. The prompt is a hint, not an instruction,
     and must be self-contained: the recipient may not have read the latest memory.
   - Do not send to origin itself; correlations involving origin go into the
     report (step 9). A rejected send is reported without deleting the record or
     automatic retry. A crash between recording and sending can lose the prompt.
9. Release once and report advanced/unadvanced groups, reasons, prompt recipients,
   and correlations involving origin for its running thread to decide on.
