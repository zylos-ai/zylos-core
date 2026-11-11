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

test('guidance treats legacy-only facts as page sources without recreating old files', () => {
  const legacy = normalize(sync.slice(sync.indexOf('This same lookup and page creation')));
  assert.match(legacy, /only source is in `reference\/legacy\/`/);
  assert.match(legacy, /move the needed facts into a category page, record its old heading in `Moved from`, and rebuild/);
  assert.match(legacy, /Never recreate the old projects.md or decisions.md path or write into legacy files/);
  assert.match(legacy, /For ongoing work found only in legacy, create the corresponding project or decision category page with `Moved from`; do not write it into infrastructure.md or leave it in group state/);
  assert.match(legacy, /Group Sync carries it in its checkpoint for Origin to perform this shared-page lookup and creation; it does not write shared pages/);
});

test('guidance audits every aged completed index row and stale navigation paths', () => {
  const audit = normalize(between(sync, '7. Before any cursor advance or checkpoint', '`origin-cursor.js advance'));
  assert.match(audit, /Check every INDEX row whose Status is completed\/abandoned and Updated is about 30 days old or older; archive every eligible row/);
  assert.match(audit, /Include navigation lines that still refer to the old paths, even if they describe those files as read-only history/);
  assert.match(audit, /legacy archive file, including navigation lines that still refer to the old paths/);
});

test('reorganization starts from the system instruction in the receiving session without messaging', () => {
  const text = normalize(reorg);
  assert.match(text, /sole session in single mode, Origin in multi mode/);
  assert.match(text, /If a reorganization worker this session started is still running, do nothing/);
  assert.match(text, /Do not ask the owner or send anyone a message/);
  assert.match(text, /Do not relay that result to the owner or anyone else/);
  assert.match(text, /no separate owner-requested entry point/);
  assert.match(text, /`model: sonnet`/);
  assert.match(text, /`gpt-6\.1-terra`, with `fork_turns: "none"`/);
  assert.match(text, /Do not wait for it with `wait_agent`/);
  assert.match(REFERENCE_REORG_PROMPT, /follow it now, without asking the owner/);
  assert.match(REFERENCE_REORG_PROMPT, /Do not message the owner or anyone else/);
});

test('reorganization finds in-progress work in global and every group state without date inference', () => {
  const state = normalize(between(reorg, '1. **Identify', '2. **Rebuild'));
  assert.match(state, /`memory\/state.md` and every existing `memory\/session-groups\/\*\/state.md`/);
  assert.match(state, /active, waiting for someone, or paused/);
  assert.match(state, /skip completed work and entries that are only reminders or rules/);
  assert.match(state, /Merge duplicate matters across the state files/);
  assert.match(state, /single-to-multi upgrade/);
  assert.match(state, /Origin's state describes only its own conversation and can be empty/);
  assert.match(state, /Do not infer in-progress work from dates in old sections/);
  assert.match(state, /If all state files are missing or list no in-progress work, create no pages and go to step 4/);
});

test('reorganization looks up existing and archived pages before searching pointed-to old sections', () => {
  const pages = normalize(between(reorg, '2. **Rebuild', '3. **Do not rebuild'));
  assert.match(pages, /Check `reference\/projects\/INDEX.md` and search `reference\/projects\/`, including `archive\/`/);
  assert.match(pages, /first run `reference-index.js unarchive --path reference\/projects\/archive\/<name>.md`/);
  assert.match(pages, /Read old sections pointed to by state first/);
  assert.match(pages, /search the latest projects archive in `reference\/legacy\/`/);
  assert.match(pages, /newest sections first, stopping when the current situation is clear/);
  assert.match(pages, /decisions directly related to this project/);
  assert.match(pages, /Record the old headings read in `Moved from`/);
  assert.match(pages, /do not change its `Status`, `Updated`, or `Description`/);
  assert.match(pages, /Supplement only `Keys` and `Moved from`/);
  assert.match(pages, /Append useful missing old facts in a final section named `整理补充（<date>）`/);
});

test('reorganization writes only project pages and generated indexes without rebuilding decisions', () => {
  for (const source of [reorg, skill]) {
    const text = normalize(source);
    assert.match(text, /system.*instruction/);
    assert.match(text, /`reference\/projects\/\*\*` \(including `unarchive`\)/);
    assert.match(text, /INDEX files generated by `rebuild`/);
    assert.match(text, /final `move-old` operation/);
    assert.match(text, /does not write pages under `reference\/decisions\/`|Do not write pages under `reference\/decisions\/`/);
  }
  assert.match(normalize(reorg), /Do not generate topic pages from the old `decisions.md`/);
  assert.match(normalize(reorg), /Standing rules remain in `preferences.md`; do not change that file/);
  assert.match(normalize(reorg), /`MEMORY_CONFLICT` leaves the file unchanged: reread, merge again and retry/);
  assert.match(normalize(reorg), /`SYNC_BUSY` means retry later/);
  assert.match(normalize(reorg), /`MEMORY_FILE_NOT_FOUND` can mean Sync moved the page/);
});

test('reorganization builds pages before archival and reports archive collisions without retrying', () => {
  const finish = normalize(between(reorg, '4. **Finish', '## Writing rules'));
  assert.match(finish, /Run `reference-index.js rebuild`, then `reference-index.js move-old`/);
  assert.match(finish, /date-time filenames without overwriting existing files/);
  assert.match(finish, /If `move-old` returns `EXISTS`, nothing moved: report it in the result returned to the spawning session and do not retry/);
  assert.match(finish, /Build pages first and move old files last/);
  assert.match(finish, /Do not leave replacement files or a completion marker at the original paths/);
});

test('interrupted reorganization waits for the next instruction and merges instead of duplicating', () => {
  const text = normalize(reorg.slice(reorg.indexOf('## Interruption')));
  assert.match(text, /Do not record progress or automatically restart the worker/);
  assert.match(text, /wait for the next system instruction/);
  assert.match(text, /after seven days/);
  assert.match(text, /Start again from step 1 and merge existing pages/);
  assert.match(text, /do not create duplicate pages/);
  assert.match(text, /`EXISTS` or `MEMORY_CONFLICT`, rereads, and merges/);
  assert.match(text, /`move-old` skips absent files/);
});


test('reorganization gives complete memory-relative paths and forbids probe pages and shell file changes', () => {
  for (const source of [reorg, skill]) {
    const text = normalize(source);
    assert.match(text, /Every `--path` is relative to the memory directory and includes the category folder/);
    for (const command of [
      'reference-index.js create --path reference/projects/<name>.md',
      'reference-index.js unarchive --path reference/projects/archive/<name>.md',
      'memory-write.js --path reference/projects/<name>.md --sha256 <hash>',
    ]) assert.ok(text.includes(command), command);
    assert.match(text, /Do not create probe or test pages/);
    assert.match(text, /never delete, move or rename memory files with shell commands such as `rm` or `mv`/);
    assert.match(text, /if a command fails, read its error or the script usage instead/);
  }
  const archive = normalize(sync.slice(sync.indexOf('## Archive and restore')));
  assert.match(archive, /archive --path reference\/projects\/<name>.md/);
  assert.match(archive, /unarchive --path reference\/projects\/archive\/<name>.md/);
});

test('reorganization excludes consent, date-based selection, Origin-only reads and progress records', () => {
  for (const source of [reorg, skill, sync, REFERENCE_REORG_PROMPT]) {
    assert.doesNotMatch(source, /reorg-progress|owner-approved|owner's agreement|Notify/);
  }
  for (const source of [reorg, REFERENCE_REORG_PROMPT]) {
    assert.doesNotMatch(source, /private chat|agree|consent|declin|30 days|checklist|progress (?:page|file)/i);
  }
  const state = between(reorg, '1. **Identify', '2. **Rebuild');
  assert.doesNotMatch(state, /only Origin/i);
  assert.doesNotMatch(sync, /reorganization progress (?:page|file)/i);
});
