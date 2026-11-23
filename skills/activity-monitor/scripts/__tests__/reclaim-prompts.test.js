import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const checks = fs.readFileSync(new URL('../../references/session-checks.md', import.meta.url), 'utf8');
const normalized = checks.replace(/\s+/g, ' ');
const section = heading => {
  const from = normalized.indexOf(`## ${heading}`);
  const to = normalized.indexOf(' ## ', from + 3);
  assert.ok(from >= 0, `Missing section ${heading}`);
  return normalized.slice(from, to < 0 ? undefined : to);
};
// Installed commands in the reference resolve to this checkout's skills.

test('every check prohibits messages and requires a current-record handoff without completed items', () => {
  assert.ok(normalized.includes('Run the named check now, following the steps below in order. During this check, do not send messages to anyone.'));
  assert.equal(section('2. Handoff'), '## 2. Handoff Otherwise write the session handoff: list open business items as they stand now, '
    + 'checking each against its current record and leaving out any that have finished. Replies, reviews or decisions you are waiting for '
    + 'from people or other sessions need nothing more: an incoming reply wakes this group again.');
  assert.doesNotMatch(normalized, /more than a day|tell the person responsible|handle each such item/);
});

