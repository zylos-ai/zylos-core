import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REFERENCE_REORG_PROMPT } from '../sync-prompts.js';

const read = name => fs.readFileSync(new URL(`../../references/${name}.md`, import.meta.url), 'utf8');
const sync = read('sync-procedures');
const reorg = read('reference-reorg');
const skill = fs.readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
const writer = read('memory-write');
const normalize = text => text.replace(/\s+/g, ' ');
const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing section ${start}`);
  return text.slice(from, to);
};

test('guidance requires all audit items and their results before Origin cursor advance', () => {
  const origin = between(sync, '## Origin Sync', '## Single global Sync');
  const audit = between(origin, '7. Before any cursor advance or checkpoint', '`node ~/zylos/.claude/skills/zylos-memory/scripts/origin-cursor.js advance');
  for (const sentence of [
    '1. Run `node ~/zylos/.claude/skills/zylos-memory/scripts/reference-index.js rebuild`.',
    '2. When `navigation.count` is nonzero',
    '3. Apply the archive/restore rule below',
    '4. When `headings.count` is nonzero',
    'write one result sentence for each item',
  ]) assert.ok(normalize(audit).includes(sentence), sentence);
  assert.match(audit, /Audit errors follow the common retry\/report-only rules/);
  assert.match(normalize(audit), /A zero count means report "no action needed" for that item and skip its manual inspection/);
  assert.match(normalize(audit), /If the check fails, report it and inspect both items manually/);
  assert.match(normalize(audit), /Execute items 1 and 3 every run/);
});

test('guidance places the global audit checklist before checkpoint and preserves report-only failures', () => {
  const global = between(sync, '## Single global Sync', '## Moving from old files');
  assert.match(normalize(global), /Before checkpoint, follow the Origin step 7 checker and conditional checklist/);
  assert.match(normalize(global), /one result sentence per item/);
  assert.match(normalize(global), /follow the common rules and do not block checkpoint/);
  assert.equal((global.match(/Before checkpoint, follow the Origin step 7/g) || []).length, 1);
  assert.doesNotMatch(global, /Audit content, navigation and size as in Origin step 7/);
});

test('guidance keeps input drift terminal without replaying completed checkpoints', () => {
  const common = normalize(between(sync, '## Common completion and failure rules', '## Group Sync'));
  assert.match(common, /`INPUT_CHANGED` also receives no retry/);
  assert.match(common, /before publishing that operation's target/);
  assert.match(common, /already completed checkpoint summary/);
  assert.match(common, /stop later writes, release once and report the mismatch/);
  assert.match(common, /Do not replace the retained input manifest or replay a completed checkpoint/);
  assert.match(common, /A later Sync must fully reread and reconcile the actual inputs/);
  assert.match(normalize(sync), /Exact provenance fields such as `- \*\*Moved from:\*\* projects.md "Old title"`/);
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
  assert.match(normalize(skill), /Read inputs with Read \(offset\/limit\), Glob, or read-only Bash commands `grep -n`, `rg -n`, `sed -n '<a>,<b>p'`, and bounded `dd` byte reads; use Grep when available/);
  assert.match(normalize(sync), /Use byte ranges even when a file contains one very long line/);
  assert.match(normalize(sync), /`dd if="<returned absolute path>" bs=1 skip=0 count=8192 status=none`/);
  assert.match(normalize(sync), /Continue at skip=8188, then 16376, increasing by 8188/);
  assert.match(normalize(sync), /the ranges must cover every byte with/);
  assert.match(normalize(sync), /Never claim a full read from a hash match/);
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
  const audit = normalize(between(sync, '7. Before any cursor advance or checkpoint', '`node ~/zylos/.claude/skills/zylos-memory/scripts/origin-cursor.js advance'));
  assert.match(audit, /Check every INDEX row whose Status is completed\/abandoned and Updated is about 30 days old or older; archive every eligible row/);
  assert.match(audit, /Include navigation lines that still refer to the old paths, even if they describe those files as read-only history/);
  assert.match(audit, /legacy archive file, including navigation lines that still refer to the old paths/);
});

test('Sync guidance centralizes corrected-call retries and preserves partial writes', () => {
  const rules = normalize(between(sync, '## Common completion and failure rules', '## Sync limits'));
  assert.match(rules, /at most TWO times per step \(the initial call plus at most two corrected retries\)/);
  for (const code of ['INVALID_INPUT', 'FRAGMENT_CONFLICT', 'EXISTS', 'STATE_DOCUMENT_INVALID']) {
    assert.ok(rules.includes(`\`${code}\`:`), code);
  }
  assert.match(rules, /These attempts do not fail the required step or release its token/);
  assert.match(rules, /the formal state has not been replaced/);
  assert.match(rules, /excludes `node ~\/zylos\/\.claude\/skills\/zylos-memory\/scripts\/reference-index.js move-old`/);
  assert.match(rules, /a later collision can follow an already completed move/);
  assert.match(rules, /does not cover migration apply outside this Sync flow/);
  assert.match(rules, /Never replay a committed prefix or restart a sequence/);
  assert.match(rules, /`WRITE_FAILED`, `LOCK_UNAVAILABLE`, `LOCK_TIMEOUT`, and tool protocol errors receive no retry/);
  assert.match(rules, /After acquisition, `TOKEN_MISMATCH` \/ exit 3 means stop immediately: no more script\/tool operations, no release, no prompts/);
  assert.match(rules, /including a missing required CLI argument/);
  assert.match(rules, /If a token error is `TOKEN_MISMATCH`, use the immediate-stop rule above/);
  assert.doesNotMatch(sync, /retry that call once/);
  assert.doesNotMatch(sync, /adding `--token` returns|Do not add `--token`/);
  const example = JSON.parse(/```json\n([^\n]+)\n```/.exec(sync)[1]);
  assert.equal(example.op, 'edit');
  assert.equal(example.token, 'T');
  assert.ok(example.path && example.expected && example.replacement);
});

test('Sync commands use installed paths listed at the beginning of the procedure', () => {
  const table = between(sync, '| Script | Installed path |', 'The zylos-memory scripts');
  const paths = [...table.matchAll(/`(~\/zylos\/\.claude\/skills\/[^`]+\.js)`/g)].map(match => match[1]);
  assert.equal(paths.length, 9);
  const commands = [...sync.matchAll(/`node ([^`\s]+\.js)(?:\s|`)/g)];
  assert.ok(commands.length > 20);
  for (const [, command] of commands) assert.ok(paths.includes(command), command);
  assert.doesNotMatch(sync.slice(sync.indexOf('## Common')), /`(?:sync-lock|sync-files|origin-cursor|reference-index|request-rotation|c4-fetch|c4-db|c4-send)\.js(?:\s|`)/);
});

test('reorganization starts from the system instruction in the receiving session', () => {
  const text = normalize(reorg);
  assert.match(text, /sole session in single mode, Origin in multi mode/);
  assert.match(text, /If a reorganization worker this session started is still running, do nothing/);
  assert.match(text, /`model: sonnet`/);
  assert.match(text, /`gpt-6\.1-terra`, with `fork_turns: "none"`/);
  assert.match(text, /Do not wait for it with `wait_agent`/);
  assert.doesNotMatch(reorg, /owner/i);
  assert.doesNotMatch(REFERENCE_REORG_PROMPT, /owner/i);
  assert.doesNotMatch(skill, /reference-reorg|one-time[^\n]*reorganization/i);
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
  assert.match(pages, /First read both `reference\/projects\/INDEX.md` and `reference\/projects\/archive\/INDEX.md`\. Then search by project names and aliases with `grep -ril` in `reference\/projects\/` \(including `archive\/`\)/);
  assert.match(pages, /first run `reference-index.js unarchive --path reference\/projects\/archive\/<name>.md`/);
  assert.match(pages, /Read old sections pointed to by state first/);
  assert.match(pages, /search the latest projects archive in `reference\/legacy\/`/);
  assert.match(pages, /newest sections first, stopping when the current situation is clear/);
  assert.match(pages, /decisions directly related to this project/);
  assert.match(pages, /Record the old headings read in `Moved from`/);
  assert.match(pages, /using the page format in \[projects-format\.md\]\(projects-format\.md\) \(Status is one of `active`, `planning`, `paused`, `completed`, `abandoned`\)/);
  assert.match(pages, /Use only `memory-write.js --append --path reference\/projects\/<name>.md` for existing pages/);
  assert.match(pages, /do not change its `Status`, `Updated`, or `Description`/);
  assert.match(pages, /The tool merges only these two header fields under the lock/);
  assert.match(pages, /Supply a complete new section named `整理补充（<date>）` on stdin; the tool appends it after the current file contents/);
  assert.match(pages, /Do not rewrite the existing page/);
});

test('reorganization writes only project pages and generated indexes without rebuilding decisions', () => {
  for (const source of [reorg]) {
    const text = normalize(source);
    assert.match(text, /system.*instruction/);
    assert.match(text, /`reference\/projects\/\*\*` \(including `unarchive`\)/);
    assert.match(text, /INDEX files generated by `rebuild`/);
    assert.match(text, /final `move-old` operation/);
    assert.match(text, /does not write pages under `reference\/decisions\/`|Do not write pages under `reference\/decisions\/`/);
  }
  assert.match(normalize(reorg), /Do not generate topic pages from the old `decisions.md`/);
  assert.match(normalize(reorg), /Standing rules remain in `preferences.md`; do not change that file/);
  assert.match(normalize(reorg), /`SYNC_BUSY` means retry the same append after Sync finishes/);
  assert.match(normalize(reorg), /`MEMORY_FILE_NOT_FOUND` can mean Sync moved the page into or out of archive: locate it again and append at its current path/);
  assert.match(normalize(reorg), /`MEMORY_FILE_NOT_FOUND` can mean Sync moved the page/);
});

test('reorganization builds pages before archival and reports archive collisions without retrying', () => {
  const finish = normalize(between(reorg, '4. **Finish', '## Writing rules'));
  assert.match(finish, /Run `reference-index.js rebuild`, then run `reference-index.js move-old` as a separate command, only after every `create`, `unarchive`, and `memory-write` operation in step 2 has returned `ok`/);
  assert.match(finish, /If any operation returns `SYNC_BUSY` or any other error, follow the writing rules and retry until it succeeds; do not run `move-old` while any write remains unsuccessful/);
  assert.match(finish, /date-time filenames without overwriting existing files/);
  assert.match(finish, /If `move-old` returns `EXISTS`, nothing moved: report it in the result returned to the spawning session and do not retry/);
  assert.match(finish, /Build pages first and move old files last/);
  assert.match(finish, /Do not leave replacement files or a completion marker at the original paths/);
});

test('interrupted reorganization waits for the next instruction and merges instead of duplicating', () => {
  const text = normalize(reorg.slice(reorg.indexOf('## Interruption')));
  assert.match(text, /Do not record progress or automatically restart the worker/);
  assert.match(text, /wait for the next system instruction/);
  assert.match(text, /next Origin\/global Sync request/);
  assert.doesNotMatch(text, /seven days|7 days/i);
  assert.match(text, /Start again from step 1 and merge existing pages/);
  assert.match(text, /do not create duplicate pages/);
  assert.match(text, /`create` returns `EXISTS` for an existing page; handle it with the append-only method above/);
  assert.match(text, /Appends share one lock and read the latest page inside that lock/);
  assert.match(text, /`move-old` skips absent files/);
});


test('reorganization gives complete memory-relative paths and forbids probe pages and shell file changes', () => {
  for (const source of [reorg]) {
    const text = normalize(source);
    assert.match(text, /Every `--path` is relative to the memory directory and includes the category folder/);
    for (const command of [
      'reference-index.js create --path reference/projects/<name>.md',
      'reference-index.js unarchive --path reference/projects/archive/<name>.md',
      'memory-write.js --append --path reference/projects/<name>.md',
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

test('existing page supplements use complete heredoc content rather than a replacement draft', () => {
  const existing = normalize(between(reorg, '- Existing pages:', 'Only write'));
  assert.match(existing, /Write out the complete nonempty `整理补充（<date>）` section in a heredoc, including any needed leading newlines/);
  assert.match(existing, /It is appended verbatim; do not pass a replacement page or generate the section with `sed`, `awk`, or similar commands, whether directly piped or first saved to a temporary file/);
});

test('existing pages use only locked appends without caller hash or replacement steps', () => {
  const existing = normalize(between(reorg, '- Existing pages:', 'Only write'));
  assert.match(existing, /Existing pages: use only `memory-write.js --append --path reference\/projects\/<name>.md`/);
  assert.match(existing, /with optional `--keys "<comma-separated values>"` and `--moved-from "<comma-separated old headings>"`/);
  assert.match(existing, /These values supplement only `Keys` and `Moved from`, deduplicated in their existing order, then new values/);
  assert.match(existing, /The tool reads the current page and merges and appends under the same lock as ordinary memory writes; it preserves every other header field and the body/);
  assert.match(normalize(reorg), /Tell it to use only `memory-write.js --append` for existing pages; new pages still use `reference-index.js create`/);
  assert.doesNotMatch(reorg, /--read|--sha256|sha256sum|hash|MEMORY_CONFLICT/);
  assert.match(normalize(writer), /Append mode neither needs nor accepts `--sha256`/);
  assert.match(normalize(writer), /After `MEMORY_CONFLICT`, read the file again, merge the current content with your changes, and rewrite with the new hash/);
});
