import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL(`../../references/${name}.md`, import.meta.url), 'utf8');
const common = read('sync-common');
const writing = read('sync-writing');
const groupDoc = read('group-sync');
const originDoc = read('origin-sync');
const globalDoc = read('global-sync');
const sync = [common, groupDoc, originDoc, globalDoc, writing].join('\n');
const skill = fs.readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
const normalize = text => text.replace(/\s+/g, ' ');
const between = (text, start, end) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing section ${start}`);
  return text.slice(from, to);
};

test('Sync parents judge success or failure only from the worker final result', () => {
  const parent = normalize(between(skill, '## Parent result handling', '## Ordinary running-thread memory'));
  assert.match(parent, /Only the worker's final result decides whether Sync succeeded or failed\. Messages the worker sends while it is still running are not a Sync outcome; do not report success or failure from them\./);
});

test('guidance requires all audit items and their results before Origin cursor advance', () => {
  const origin = between(sync, '## Origin Sync', '## Single global Sync');
  const audit = between(origin, '7. Before any cursor advance or checkpoint', 'node ~/zylos/.claude/skills/zylos-memory/scripts/origin-cursor.js advance');
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
