import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REFERENCE_REORG_PROMPT } from '../sync-prompts.js';

const read = name => fs.readFileSync(new URL(`../../references/${name}.md`, import.meta.url), 'utf8');
const sync = read('sync-procedures');
const reorg = read('reference-reorg');
const skill = fs.readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
const normalize = text => text.replace(/\s+/g, ' ');
const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing section ${start}`);
  return text.slice(from, to);
};

test('guidance requires all audit items and their results before Origin cursor advance', () => {
  const origin = between(sync, '## Origin Sync', '## Single global Sync');
  const audit = between(origin, '7. Before any cursor advance or checkpoint', '`origin-cursor.js advance');
  for (const sentence of [
    '1. Run `reference-index.js rebuild`.',
    '2. Only after rebuild succeeds and both category INDEX files exist',
    '3. Apply the archive/restore rule below',
    '4. Once old files have moved into `reference/legacy/`',
    'write one result sentence for each item',
  ]) assert.ok(normalize(audit).includes(sentence), sentence);
  assert.match(audit, /Audit errors are report-only/);
  assert.match(normalize(audit), /`TOKEN_MISMATCH`, which stops everything/);
});

test('guidance places the global audit checklist before checkpoint and preserves report-only failures', () => {
  const global = between(sync, '## Single global Sync', '## Moving from old files');
  assert.match(normalize(global), /Before checkpoint, execute each item of the Origin step 7 checklist individually/);
  assert.match(normalize(global), /one result sentence per item/);
  assert.match(normalize(global), /do not block checkpoint, except `TOKEN_MISMATCH`/);
  assert.equal((global.match(/Before checkpoint, execute each item/g) || []).length, 1);
  assert.doesNotMatch(global, /Audit content, navigation and size as in Origin step 7/);
});

test('guidance counts unchecked subitems across the full progress page before move-old', () => {
  const finish = normalize(between(reorg, '4. **Finish', '## Interruption'));
  assert.match(finish, /count every `- \[ \]` occurrence across the entire progress page, including all subitems, not only top-level items/);
  assert.match(finish, /Only a count of zero allows `move-old`; otherwise continue processing/);
  assert.match(finish, /worker's check, not a completion check added to the script/);
  const example = between(reorg, '   ```markdown\n', '   ```').replace(/^ {3}/gm, '');
  assert.equal(example.split('\n').includes('- [ ] L900 ### Pending production work'), true);
  assert.equal(example.split('\n').some(line => /^\s+- \[[ x]\]/.test(line)), false);
  assert.match(normalize(reorg), /Each `###` subitem is an independent checkbox line/);
  assert.match(normalize(reorg), /column one, never an indented or nested list item/);
});

test('guidance stops after archival without recreating progress or notifying twice', () => {
  const text = normalize(reorg);
  assert.match(text, /reorganization is finished: stop without creating or rebuilding `reorg-progress.md` or sending another completion notice/);
  assert.equal((text.match(/stop without creating or rebuilding `reorg-progress.md`/g) || []).length, 1);
});

test('guidance preserves the question commitment without recording refusal or silence as a lasting decision', () => {
  const text = normalize(reorg);
  assert.match(text, /After asking, record one inbox commitment saying where you asked and that owner agreement means starting this procedure/);
  assert.match(text, /If the owner declines or does not reply, write no new memory afterward: no decision page, no state entry, and no further inbox item/);
  assert.match(text, /Keep the question-time commitment as it is; do not rewrite it into a lasting conclusion/);
  assert.match(text, /On the next proposal, ask the owner once as usual/);
  assert.match(REFERENCE_REORG_PROMPT, /If the owner declines or does not reply, write no new memory: no decision, state entry, or further inbox item/);
});

test('guidance requires full-item reading and both allowed sources for ongoing work', () => {
  const process = normalize(between(reorg, '2. **Read each item', '3. **Merge'));
  assert.match(process, /Read from its heading through the next heading at the same or higher level/);
  assert.match(process, /Do not read only the latest status block, and never check an item without reading all of it/);
  assert.match(process, /Identify every ongoing matter anywhere in the item and create a page or merge it into an existing page/);
  assert.match(process, /work still listed in current state.md/);
  assert.match(process, /updated within 30 days and not marked completed or abandoned/);
  assert.match(process, /Treat other work as ended and leave it in the old file for archival/);
});

test('guidance prevents recursive delegation while allowing safe overlap after session replacement', () => {
  const text = normalize(reorg);
  assert.match(text, /worker processes every item itself/);
  assert.match(text, /must not spawn subagents or delegate items in parallel/);
  assert.match(text, /If two workers overlap after session replacement, create and memory-write prevent them overwriting one another/);
  assert.doesNotMatch(text, /start a replacement only after|stale worker|stop it before resuming|including during resumption/);
  assert.equal((text.match(/starts only one worker at a time/g) || []).length, 1);
  assert.ok(reorg.indexOf('The worker processes every item itself') > reorg.indexOf('- Codex:'));
});

test('guidance preserves real start time and full headings and splits large sections in both modes', () => {
  const text = normalize(reorg);
  assert.match(text, /Obtain Started from the system clock when creating the page; preserve it on resumption/);
  assert.match(text, /Preserve each full heading verbatim; do not truncate it to 100 characters/);
  assert.match(text, /In both single and multi mode, split sections exceeding about 64 KiB into checklist items/);
  assert.match(text, /keep the `##` line as an item covering only the text before the first `###`; each `###` line covers its own subsection/);
  assert.match(text, /for a split `##` item, stop before its first `###`/);
  assert.match(text, /If there are no `###` headings, keep the original item and read it in consecutive bounded parts/);
  assert.match(text, /If a subitem still exceeds 64 KiB, read it in consecutive bounded parts through its end before checking it off/);
});

test('guidance uses bounded read-only source reads available in each runtime', () => {
  for (const source of [sync, reorg]) {
    const text = normalize(source);
    assert.match(text, /Search with `grep -n` or `rg -n` \(Grep is also allowed when available\); read with Read offset\/limit or `sed -n '<a>,<b>p'`/);
    assert.match(text, /Do not read an entire old file into a script/);
    assert.match(text, /Do not use `cat` or print an entire old file, and never write old files/);
  }
  const lookup = between(sync, '## Moving from old files', '## Archive and restore');
  assert.doesNotMatch(lookup, /TOOL_UNAVAILABLE|Read\/Glob\/Grep/);
  assert.doesNotMatch(reorg, /TOOL_UNAVAILABLE|Read\/Glob\/Grep/);
  assert.match(normalize(skill), /Read inputs with Read \(offset\/limit\), Glob, or read-only Bash commands `grep -n`, `rg -n`, and `sed -n '<a>,<b>p'`; use Grep when available/);
  assert.match(normalize(skill), /Memory writes still use only the documented tools and scripts/);
  assert.doesNotMatch(skill, /Use Read\/Glob\/Grep for inputs and Bash only/);
});

test('guidance prevents Sync from recording a reorganization refusal or silence as a decision or task', () => {
  assert.match(normalize(sync), /An owner's refusal or silence in response to a memory reorganization proposal is neither a decision nor a pending task; do not record it in memory/);
});

test('guidance treats legacy-only facts as page sources without recreating old files', () => {
  const legacy = normalize(sync.slice(sync.indexOf('This same lookup and page creation')));
  assert.match(legacy, /only source is in `reference\/legacy\/`/);
  assert.match(legacy, /move the needed facts into a category page, record its old heading in `Moved from`, and rebuild/);
  assert.match(legacy, /Never recreate the old projects.md or decisions.md path or write into legacy files/);
  assert.match(legacy, /For ongoing work found only in legacy, create the corresponding project or decision category page with `Moved from`; do not write it into infrastructure.md or leave it in group state/);
  assert.match(legacy, /Group Sync carries it in its checkpoint for Origin to perform this shared-page lookup and creation; it does not write shared pages/);
});

test('guidance checks only fully read items in the current batch and forbids bulk completion', () => {
  const process = normalize(between(reorg, '2. **Read each item', '3. **Merge'));
  assert.match(process, /Check off an item only in the batch in which you have read it in full/);
  assert.match(process, /Do not use scripts or a single bulk operation to check off items/);
  assert.match(process, /Do not use helper scripts to truncate or summarize sections/);
  assert.match(process, /If you cannot finish, stop and leave unread items unchecked/);
  const finish = normalize(between(reorg, '4. **Finish', '## Interruption'));
  assert.match(finish, /Do not run `move-old` unless every item has been read in full and processed individually/);
  assert.match(finish, /a zero count alone does not establish that/);
  assert.match(finish, /Never bulk-check items to reach zero/);
});

test('guidance keeps worker reports accurate and completion notification unique during resumption', () => {
  for (const section of [
    between(reorg, '## Start one background worker', '## Worker procedure'),
    reorg.slice(reorg.indexOf('## Interruption and resumption')),
  ]) {
    const text = normalize(section);
    assert.match(text, /Relay (?:the worker's|its) report faithfully(?:,)? without overstating it/);
    assert.match(text, /worker's notification is the only completion message; unless the owner asks, send no additional follow-up message/);
  }
});

test('guidance makes refusal handling survive inbox handoff without suppressing future proposals', () => {
  const ask = normalize(between(reorg, '## Find the private conversation and ask', '## Start one background worker'));
  assert.match(ask, /Send that text verbatim with only the placeholders filled in; add nothing/);
  assert.match(ask, /Previous refusal or no reply, however recent, is not a reason to skip asking/);
  assert.match(ask, /seven-day interval is the only pacing rule/);
  for (const text of [ask, REFERENCE_REORG_PROMPT]) {
    assert.match(text, /Include in that commitment itself: refusal or no reply needs no memory update; the system will ask again after seven days/);
  }
  assert.match(REFERENCE_REORG_PROMPT, /sending the documented internal message verbatim with only placeholders filled in and nothing added/);
  const common = normalize(between(sync, '## Common completion', '## Sync limits'));
  assert.match(common, /applies to group Sync as well as Origin and global Sync/);
  assert.match(common, /do not put it in state's Headline, ended items, checkpoint summaries, decision pages or inbox/);
  assert.match(common, /Do not turn it into an instruction to wait for the owner or avoid asking again/);
});

test('guidance audits every aged completed index row and stale navigation paths', () => {
  const audit = normalize(between(sync, '7. Before any cursor advance or checkpoint', '`origin-cursor.js advance'));
  assert.match(audit, /Check every INDEX row whose Status is completed\/abandoned and Updated is about 30 days old or older; archive every eligible row/);
  assert.match(audit, /Include navigation lines that still refer to the old paths, even if they describe those files as read-only history/);
  assert.match(audit, /legacy archive file, including navigation lines that still refer to the old paths/);
});

test('guidance groups decision pages by topic rather than date or old heading blocks', () => {
  const process = normalize(between(reorg, '2. **Read each item', '3. **Merge'));
  assert.match(process, /For decisions, group pages by topic, not date ranges or old heading blocks/);
});
