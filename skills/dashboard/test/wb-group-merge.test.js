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

test('a preview that is not a person\'s words names its source and keeps the stored start for the technical view', () => {
  const secret = 'sk-' + 'z'.repeat(32);
  const stored = '[Scheduled Task: task-ab12cd34 #2]\nrotate the key\n' + 'step '.repeat(30) + '\nuse ' + secret + ' and https://x.test/?token=abc';
  const scheduled = { preview: { text: [...stored].slice(0, 80).join(''), message: 'rotate the key', timestamp: 1, channel: 'scheduler',
    messageSource: { kind: 'scheduled_task', taskId: 'task-ab12cd34' }, messageRaw: stored } };
  const named = safePreview(scheduled, undefined, new Map([['task-ab12cd34', 'Key rotation ' + secret]]));
  assert.deepEqual(named, { timestamp: 1, channel: 'scheduler', text: 'Key rotation [REDACTED]', source: { kind: 'scheduled_task' },
    raw: stored.replace(secret, '[REDACTED]').replace('token=abc', 'token=[REDACTED]') });
  assert.ok(named.raw.includes('\nrotate the key\n'), 'line breaks stay');
  assert.equal(safePreview(scheduled).text, 'rotate the key', 'without a name the prompt line stays');
  const header = { preview: { text: '[Bot] see https://x.test/?token=abc', message: 'see https://x.test/?token=abc', timestamp: 2, channel: 'lark',
    messageSource: { kind: 'header' }, messageRaw: '[Bot] see https://x.test/?token=abc' } };
  assert.deepEqual(safePreview(header), { timestamp: 2, channel: 'lark', text: 'see https://x.test/?token=[REDACTED]', source: { kind: 'channel' }, raw: '[Bot] see https://x.test/?token=[REDACTED]' });
  const person = { preview: { text: '[TG DM] howard said: hi', message: 'hi', timestamp: 3, channel: 'telegram' } };
  assert.deepEqual(safePreview(person), { timestamp: 3, channel: 'telegram', text: 'hi' });
  // A source this reader does not know is shown as a person's words, without a label or stored start.
  assert.deepEqual(safePreview({ preview: { ...person.preview, messageSource: { kind: 'future' }, messageRaw: 'raw' } }), { timestamp: 3, channel: 'telegram', text: 'hi' });
});

test('the preview drops credential values from links but keeps the link readable', () => {
  const said = { preview: { message: 'open https://x.test/a?token=abc123&page=2 and https://y.test/b?id=1&api_key=K-9.z#top', timestamp: 1, channel: 'lark' } };
  assert.equal(safePreview(said).text, 'open https://x.test/a?token=[REDACTED]&page=2 and https://y.test/b?id=1&api_key=[REDACTED]#top');
  assert.equal(redactQuerySecrets('?access_token=t1&Signature=s2&X-Auth=a3&PASSWORD=p4'), '?access_token=[REDACTED]&Signature=[REDACTED]&X-Auth=[REDACTED]&PASSWORD=[REDACTED]');
  // The value ends at whitespace, "&", "#" or the first non-ASCII character: the words after the link stay.
  assert.equal(redactQuerySecrets('用?token=abc来连接'), '用?token=[REDACTED]来连接');
  assert.equal(redactQuerySecrets('https://x.test/?key=a1 then more'), 'https://x.test/?key=[REDACTED] then more');
  // Names are matched as whole words: these are not credentials.
  assert.equal(redactQuerySecrets('https://x.test/?monkey=1&hotkey=2&keyboard=us&tokens2=3'), 'https://x.test/?monkey=1&hotkey=2&keyboard=us&tokens2=3');
  // camelCase names split at the case change, and an HTML-escaped "&amp;" separates parameters like "&".
  assert.equal(redactQuerySecrets('https://x.test/?accessToken=a1&authToken=b2&clientSecret=c3&APIKey=d4'), 'https://x.test/?accessToken=[REDACTED]&authToken=[REDACTED]&clientSecret=[REDACTED]&APIKey=[REDACTED]');
  assert.equal(redactQuerySecrets('<a href="https://x.test/?page=2&amp;token=abc&amp;id=7">'), '<a href="https://x.test/?page=2&amp;token=[REDACTED]&amp;id=7">');
  assert.equal(redactQuerySecrets('https://x.test/?monkeyKing=1&hotKeys=2&tokenizer=3'), 'https://x.test/?monkeyKing=1&hotKeys=2&tokenizer=3', 'no credential word: kept');
  // A link nested in another parameter's value loses its credential too; the outer value stays readable.
  assert.equal(redactQuerySecrets('https://x.test/login?redirect=https://y/?token=abc'), 'https://x.test/login?redirect=https://y/?token=[REDACTED]');
  assert.equal(redactQuerySecrets('?next=/cb?access_token=abc&page=2'), '?next=/cb?access_token=[REDACTED]&page=2');
  assert.equal(redactQuerySecrets('?a=b?token=abc'), '?a=b?token=[REDACTED]');
  assert.equal(redactQuerySecrets('?next=/cb?monkey=1'), '?next=/cb?monkey=1', 'nested, no credential word: kept');
  // Only a URL query parameter counts: "token=" written in a sentence, or after another separator, stays.
  assert.equal(redactQuerySecrets('the token=abc field and monkey business'), 'the token=abc field and monkey business');
  assert.equal(redactQuerySecrets('a;token=abc and (key=abc)'), 'a;token=abc and (key=abc)');
});
