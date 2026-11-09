import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeGroups, redactQuerySecrets, safePreview } from '../src/lib/workbench/group-merge.js';
const live = (sessionGroup, presence = 'running') => ({ sessionGroup, presence });
const status = { view: 'multi', origin: live('origin', 'not_running'), groups: [live('a')], groupListError: null };
const group = sessionGroup => ({ sessionGroup, componentName: 'telegram', sessionGroupName: sessionGroup, lastActivityAt: 100 });
const c4 = { ok: true, data: { groups: [group('a'), group('b')], hasOlder: true } };
const q = { ok: true, data: { groups: [{ sessionGroup: 'a' }, { sessionGroup: 'queued' }] } };

test('group merge includes live, recent and queue groups once, with Origin first', () => {
  const result = mergeGroups({ status, c4, q, names: new Map([['a', 'Research']]) });
  assert.deepEqual(result.rows.map(row => row.sessionGroup), ['origin', 'a', 'b', 'queued']);
  assert.equal(result.rows[1].presence, 'running');assert.equal(result.rows[1].name, 'Research');
  assert.equal(result.rows[2].presence, 'not_running');assert.equal(result.rows[3].presence, 'not_running');
  assert.equal(result.hasOlder, true);
});
test('live-only groups keep empty C4 metadata without inventing a missing-record diagnostic', () => {
  const result = mergeGroups({ status: { ...status, groups: [live('old-live')] }, c4: { ok: true, data: { groups: [], hasOlder: false } }, q: { ok: false } });
  const row = result.rows[1];assert.equal(row.sessionGroup, 'old-live');assert.equal(row.c4, null);assert.equal(row.preview, null);
  assert.equal(row.reason, null);assert.equal(result.hasOlder, false);
});
test('unknown group list and failed status never manufacture an absent observation', () => {
  for (const [source, reason] of [[{ ...status, groupListError: { code: 'EIO' } }, 'group_list_failed'], [null, 'status_unreadable']]) {
    const result = mergeGroups({ status: source, statusError: source ? null : reason, c4, q });
    const row = result.rows.find(row => row.sessionGroup === 'b');assert.equal(row.presence, 'unknown');assert.equal(row.reason, reason);
  }
});
test('failed C4 retains live and queue rows but does not claim whether older groups exist', () => {
  const result = mergeGroups({ status, c4: { ok: false, reason: 'c4_groups_failed' }, q });
  assert.deepEqual(result.rows.map(row => row.sessionGroup), ['origin', 'a', 'queued']);assert.equal(result.hasOlder, null);
});
test('single view has only the unique null-key session regardless of other sources', () => {
  const result = mergeGroups({ status: { ...status, view: 'single', origin: live(null) }, c4, q });
  assert.equal(result.rows.length, 1);assert.equal(result.rows[0].sessionGroup, null);assert.equal(result.rows[0].title, '唯一会话');assert.equal(result.hasOlder, null);
});
test('C4 Origin is deduplicated and browser fields never include raw preview through metadata', () => {
  const secret = 'sk-' + 'x'.repeat(32);
  const input = { ...group('origin'), preview: { text: secret, timestamp: 10 } };
  const result = mergeGroups({ status, c4: { ok: true, data: { groups: [input], hasOlder: false } }, q });
  assert.equal(result.rows.filter(row => row.sessionGroup === 'origin').length, 1);
  assert.equal(Object.hasOwn(result.rows[0].c4, 'preview'), false);assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.rows[0].preview.text, '[REDACTED]');assert.equal(input.preview.text, secret);
});
test('the preview shows what the person said, or nothing when the channel wrapping has no current message', () => {
  const secret = 'sk-' + 'y'.repeat(32);
  const said = { ...group('a'), preview: { text: '[OM-RUN r_1] [OPENMAX DM] (org: Enjoy) <org-context', message: 'please check ' + secret, timestamp: 10, channel: 'openmax' } };
  const wrapped = { ...group('b'), preview: { text: '[OM-RUN r_2] [OPENMAX DM] (org: Enjoy) <org-context', message: null, timestamp: 20, channel: 'openmax' } };
  const rows = mergeGroups({ status, c4: { ok: true, data: { groups: [said, wrapped], hasOlder: false } }, q }).rows;
  const preview = key => rows.find(row => row.sessionGroup === key).preview;
  assert.equal(preview('a').text, 'please check [REDACTED]');
  assert.equal(Object.hasOwn(preview('a'), 'message'), false, 'the unredacted field is not passed on');
  assert.equal(preview('b').text, null);
  assert.equal(preview('b').channel, 'openmax'); assert.equal(preview('b').timestamp, 20);
  assert.ok(!JSON.stringify(rows).includes(secret) && !JSON.stringify(rows).includes('OM-RUN'));
});

test('the preview drops credential values from links but keeps the link readable', () => {
  const said = { preview: { message: 'open https://x.test/a?token=abc123&page=2 and https://y.test/b?id=1&api_key=K-9.z#top', timestamp: 1, channel: 'lark' } };
  assert.equal(safePreview(said).text, 'open https://x.test/a?token=[REDACTED]&page=2 and https://y.test/b?id=1&api_key=[REDACTED]#top');
  assert.equal(redactQuerySecrets('?access_token=t1;Signature=s2&X-Auth=a3&PASSWORD=p4'), '?access_token=[REDACTED];Signature=[REDACTED]&X-Auth=[REDACTED]&PASSWORD=[REDACTED]');
  // Words that only look similar, and a key outside a query string, stay.
  assert.equal(redactQuerySecrets('the token= field and monkey business ?page=2&keyboard=us'), 'the token= field and monkey business ?page=2&keyboard=us');
});
