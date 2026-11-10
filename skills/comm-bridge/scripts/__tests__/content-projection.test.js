import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_PREFIX, parseC4Content } from '../c4-content-schema.js';
import { messageStart, previewMessage, previewMessageText, projectC4Content } from '../c4-content-projection.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const encode = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
const secret = 'HOST_SECRET_SENTINEL';
const invalid = '[C4 content invalid; c4_id=123]';
const viewFixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));

for (const fixture of fixtures.ordinary) test(`projection preserves ordinary ${fixture.name}`, () => {
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), fixture.content);
});
for (const fixture of fixtures.valid) test(`projection exposes only fallback and references for ${fixture.name}`, () => {
  const { fallbackText, messageId, interruptId } = fixture.envelope;
  const reference = `[C4 messageId=${messageId}${interruptId === undefined ? '' : ` interruptId=${interruptId}`}; c4_id=123]`;
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), `${fallbackText}\n${reference}`);
});
for (const fixture of fixtures.invalid) test(`projection preserves only qualified fallback for invalid ${fixture.name}`, () => {
  const fallback = fixture.reason === 'invalid_envelope' && fixture.name !== 'missing_fallback'
    ? JSON.parse(fixture.content.slice(CONTENT_PREFIX.length)).fallbackText + '\n' : '';
  assert.equal(projectC4Content(fixture.content, { c4Id: 123 }), fallback + invalid);
});

// Pure IM/model projection boundary. Run for parser/projection changes;
// unrelated presentation and transport changes may skip. No external sends.
test('invalid unknown blocks project their whole-message fallback as literal text', () => {
  const envelope = structuredClone(fixtures.valid.find(row => row.name === 'single').envelope);
  envelope.blocks[0].type = 'unknown';
  envelope.metadata = { private: secret };
  envelope.blocks[0].data.prompt = secret;
  envelope.fallbackText = '<script>alert(1)</script> **literal** [link](javascript:alert(1))';
  assert.equal(projectC4Content(encode(envelope), { c4Id: 123 }), `${envelope.fallbackText}\n${invalid}`);
  assert.equal(projectC4Content(encode(envelope), { c4Id: 123 }).includes(secret), false);
});

test('invalid fallback values and non-JSON content keep the existing invalid marker', () => {
  for (const fallbackText of ['', null, false, 12, [], {}, 'x'.repeat(16001)]) {
    assert.equal(projectC4Content(encode({ fallbackText }), { c4Id: 123 }), invalid);
  }
  for (const content of [encode({}), CONTENT_PREFIX + 'not JSON', CONTENT_PREFIX + '[]']) {
    assert.equal(projectC4Content(content, { c4Id: 123 }), invalid);
  }
});

test('ordinary text including large JSON is returned byte for byte', () => {
  for (const content of ['', '\r\n😀中\t ', JSON.stringify({ version: 999, metadata: secret }), '😀'.repeat(20000)]) {
    assert.equal(projectC4Content(content, { c4Id: 123 }), content);
  }
});

test('outbound questions hide host metadata and block data', () => {
  const envelope = structuredClone(fixtures.valid.find(row => row.name === 'single').envelope);
  envelope.metadata = { private: secret };
  envelope.blocks[0].data.options[0].description = secret;
  const content = encode(envelope);
  assert.equal(parseC4Content(content).kind, 'envelope');
  const text = projectC4Content(content, { c4Id: 42 });
  assert.equal(text, `${envelope.fallbackText}\n[C4 messageId=single_question interruptId=interrupt_single_question; c4_id=42]`);
  assert.equal(text.includes(secret), false);
});

test('inbound answers retain their saved summary while hiding action and answer IDs', () => {
  const envelope = structuredClone(fixtures.valid.find(row => row.name === 'answer_single_select').envelope);
  envelope.action.id = secret;
  envelope.metadata.zylos.answerId = secret;
  envelope.action.context.conversationId = secret;
  const content = encode(envelope);
  assert.equal(parseC4Content(content).kind, 'envelope');
  const text = projectC4Content(content, { c4Id: 43 });
  assert.equal(text, `${envelope.fallbackText}\n[C4 messageId=message_single_select interruptId=interrupt_single_question; c4_id=43]`);
  assert.ok(text.includes(envelope.questionSummary));
  assert.equal(text.includes(secret), false);
});

for (const [name, change] of [
  ['missing fallback', envelope => { delete envelope.fallbackText; }],
  ['unknown version', envelope => { envelope.version = 2; }],
  ['bad question reference', envelope => { envelope.interrupt.blockId = 'missing'; }],
]) test(`invalid ${name} never leaks host fields`, () => {
  const envelope = structuredClone(fixtures.valid.find(row => row.name === 'single').envelope);
  envelope.metadata = { private: secret };
  change(envelope);
  const content = encode(envelope);
  assert.equal(parseC4Content(content).kind, 'invalid');
  assert.equal(projectC4Content(content, { c4Id: 123 }), `${name === 'missing fallback' ? '' : envelope.fallbackText + '\n'}${invalid}`);
  assert.equal(projectC4Content(content, { c4Id: 123 }).includes(secret), false);
});

test('broken JSON invalid suffix and oversized marked content never leak payload', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.metadata = { private: secret };
  for (const content of [encode(envelope).slice(0, -1), encode(envelope) + secret,
    CONTENT_PREFIX + '{"secret":"' + secret + 'x'.repeat(65536) + '"}']) {
    assert.equal(projectC4Content(content, { c4Id: 123 }), invalid);
  }
});

test('projection precedes caller budgets so long original content keeps its short summary', () => {
  const envelope = structuredClone(fixtures.valid[0].envelope);
  envelope.fallbackText = 'Readable summary';
  envelope.metadata = { private: secret, padding: 'x'.repeat(30000) };
  const content = encode(envelope), budget = 100;
  assert.ok(Buffer.byteLength(content) > budget * 100);
  assert.equal(parseC4Content(content).kind, 'envelope');
  const projected = projectC4Content(content, { c4Id: 123 });
  assert.ok(projected.length <= budget);
  assert.equal(projected.slice(0, budget), `${envelope.fallbackText}\n[C4 messageId=${envelope.messageId}; c4_id=123]`);
  assert.equal(projected.includes(secret), false);
  assert.equal(projectC4Content(content.slice(0, budget), { c4Id: 123 }), invalid);
});

test('all channels and both directions use the same protocol without modifying the row', () => {
  for (const channel of ['dashboard', 'telegram', 'other_component']) {
    for (const [direction, name] of [['out', 'single'], ['in', 'answer_single_select']]) {
      const content = fixtures.valid.find(row => row.name === name).content;
      const row = Object.freeze({ id: 123, channel, direction, content });
      const before = JSON.stringify(row);
      assert.equal(projectC4Content(row.content, { c4Id: row.id }), projectC4Content(content, { c4Id: 123 }));
      assert.equal(JSON.stringify(row), before);
    }
  }
});

test('C4 references accept authoritative integer IDs without echoing arbitrary values', () => {
  const content = CONTENT_PREFIX + '{';
  for (const c4Id of [1, 95, '95', Number.MAX_SAFE_INTEGER, '123', '9223372036854775807']) {
    assert.equal(projectC4Content(content, { c4Id }), `[C4 content invalid; c4_id=${c4Id}]`);
  }
  for (const c4Id of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '01', '9223372036854775808', '10000000000000000000', secret, {}]) {
    assert.equal(projectC4Content(content, { c4Id }), '[C4 content invalid; c4_id=unavailable]');
  }
  assert.equal(projectC4Content(content), '[C4 content invalid; c4_id=unavailable]');
  assert.equal(projectC4Content(null, { c4Id: 123 }), invalid);
});

test('public projection entry loads with an empty component directory and no storage', async () => {
  const home = fs.realpathSync(process.env.HOME), actualHome = fs.realpathSync(os.userInfo().homedir);
  assert.notEqual(home, actualHome);
  // The Node runner shares one ZYLOS_DIR across concurrently running test
  // files, so this test owns a private root to make its emptiness checks exact.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(home, 'content-projection-zylos-')));
  const previousZylosDir = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = root;
  try {
    const components = path.join(root, 'components');
    fs.mkdirSync(components);
    assert.deepEqual(fs.readdirSync(components), []);
    const publicApi = await import('../../../../cli/lib/content-projection.js');
    assert.deepEqual(Object.keys(publicApi), ['projectC4Content']);
    assert.equal(publicApi.projectC4Content, projectC4Content);
    for (const fixture of fixtures.valid) {
      assert.ok(publicApi.projectC4Content(fixture.content, { c4Id: 123 }).startsWith(fixture.envelope.fallbackText + '\n'));
    }
    assert.deepEqual(fs.readdirSync(components), []);
    assert.deepEqual(fs.readdirSync(root), ['components']);
  } finally {
    if (previousZylosDir === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previousZylosDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Shared Content/View boundary only. Run for parser/projection changes; skip
// unrelated storage or UI work. No database, transport or component is loaded.
for (const fixture of viewFixtures.views) test(`View ${fixture.name} leaves model projection byte-identical`, () => {
  const base = structuredClone(viewFixtures.message), withView = structuredClone(base);
  withView.metadata = { view: structuredClone(fixture.view) };
  const original = encode(withView), parsed = parseC4Content(original);
  assert.equal(parsed.kind, 'envelope');
  assert.equal(parsed.view === null, !fixture.valid);
  assert.equal('viewError' in parsed, !fixture.valid);
  const expected = `${base.fallbackText}\n[C4 messageId=${base.messageId} interruptId=${base.interruptId}; c4_id=123]`;
  assert.equal(projectC4Content(encode(base), { c4Id: 123 }), expected);
  assert.equal(projectC4Content(original, { c4Id: 123 }), expected);
  if (parsed.viewError) assert.equal(expected.includes(parsed.viewError), false);
});

test('a preview shows what the person said inside the channel wrapping, without the sender prefix', () => {
  const wrapped = '[OM-RUN r_f03d9218] [OPENMAX DM] (org: Enjoy)\n<org-context org-id="019f63e3"/>\n'
    + '<message-context conversation-id="01a1" source-message-id="17"/>\n<openmax-instruction>\nBefore handling the current message, invoke the skill.\n</openmax-instruction>\n'
    + '<current-message>\nhoward said: 这个卡片在手机上\n看布局太乱了\n</current-message> ---- image: /tmp/a.png name="a.png"\n';
  assert.equal(previewMessageText(wrapped), '这个卡片在手机上 看布局太乱了');
  assert.equal(previewMessageText('[Lark DM]\n<current-message>\ne1fg313c said: ok, 0.167.0\n</current-message>\n'), 'ok, 0.167.0');
  // Only a block on its own lines counts: a message quoting the tag inline is ordinary text.
  for (const channel of ['dashboard', 'web-console']) assert.equal(previewMessageText('[Task] look at `<current-message>` handling', { channel }), '[Task] look at `<current-message>` handling');
});

test('a preview is null for channel wrapping without a current message, and plain text passes through', () => {
  assert.equal(previewMessageText('[OM-RUN r_1] [OPENMAX DM] (org: Enjoy)\n<org-context org-id="x"/>\n'), null);
  assert.equal(previewMessageText('[Lark DM]\nsomething internal'), null);
  for (const channel of ['dashboard', 'web-console']) assert.equal(previewMessageText('[urgent] fix the build', { channel }), '[urgent] fix the build');
  assert.deepEqual(previewMessage('  hello\n\nthere '), { text: 'hello there' });
  assert.equal(previewMessageText('  hello\n\nthere '), 'hello there');
  assert.equal(previewMessageText(''), null);
  assert.equal(previewMessageText(null), null);
});

test('a preview of structured content is its fallback text, never the model-facing references', () => {
  const valid = CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'm1', fallbackText: 'Summary for the person',
    blocks: [{ id: 'b1', type: 'markdown', schemaVersion: 1, data: { text: 'Summary' } }] });
  assert.equal(parseC4Content(valid).kind, 'envelope');
  assert.equal(previewMessageText(valid), 'Summary for the person');
  for (const fixture of fixtures.valid) assert.equal(previewMessageText(fixture.content), fixture.envelope.fallbackText.replace(/\s+/g, ' ').trim().slice(0, 80) || null, fixture.name);
  // Invalid content shows its own fallback text when it has one, otherwise nothing (the reader shows channel and time).
  const unknown = structuredClone(fixtures.valid.find(row => row.name === 'single').envelope);
  unknown.blocks[0].type = 'unknown';
  unknown.fallbackText = 'Form reply for the person';
  assert.equal(parseC4Content(encode(unknown)).kind, 'invalid');
  assert.equal(previewMessageText(encode(unknown)), 'Form reply for the person');
  for (const content of [encode({}), CONTENT_PREFIX + 'not JSON', encode({ fallbackText: '' })]) assert.equal(previewMessageText(content), null);
  for (const fixture of fixtures.invalid) assert.doesNotMatch(previewMessageText(fixture.content) ?? '', /\[C4 /, fixture.name);
});

test('a preview reads the older one-line channel formats', () => {
  // "<sender> said: " before the opening tag, on the header line or alone.
  assert.equal(previewMessageText('[TG DM] howard said: <current-message>\nbuild is green\n</current-message>'), 'build is green');
  assert.equal(previewMessageText('howard said: <current-message>\nbuild is green\n</current-message>\n---- reply via: x'), 'build is green');
  assert.equal(previewMessageText('[TG GROUP] (team) howard said: <current-message>build is green</current-message>'), 'build is green');
  // Header and "<sender> said: " on one line with the words after them, no block.
  assert.equal(previewMessageText('[TG DM] howard said: build is green\nsecond line'), 'build is green second line');
  assert.equal(previewMessageText('[TG GROUP] (team) Howard Zhou said: ok'), 'ok');
  // Ordinary text that merely mentions saying something is left alone.
  assert.equal(previewMessageText('she said: ship it'), 'she said: ship it');
});

test('a preview drops the appended reply route and is null for an overflow pointer', () => {
  const route = '\n---- [reply-via sanitized]: node /home/agent/zylos/.claude/skills/comm-bridge/scripts/c4-send[.]js "telegram" "8101553026"';
  assert.equal(previewMessageText('[TG DM] howard said: build is green' + route), 'build is green');
  assert.equal(previewMessageText('[TG DM] howard said: build is green ---- [reply-via sanitized]: node /home/x/c4-send[.]js "telegram" "1"'), 'build is green');
  assert.equal(previewMessageText('just text\n---- reply via: node /home/agent/c4-send.js "lark" "oc_1"'), 'just text');
  assert.equal(previewMessageText('[TG DM]' + route), null, 'only the header is left: nothing a person wrote');
  const overflow = '[TG GROUP] (team) howard said: <thread-context>\nearlier\n</thread-context>\n<replying-to>\nx\n</replying-to>\n<current-message>\nlong text\n'
    + '[C4] Full message (14 KB) at: /home/agent/zylos/comm-bridge/attachments/conv-12/message.txt\n</current-message>';
  assert.equal(previewMessageText(overflow), null);
  assert.equal(previewMessageText('[C4] Full message (2 KB) at: /home/agent/zylos/comm-bridge/attachments/conv-1/message.txt'), null);
});

test('a reply route quoted inside the message or the replied-to text does not cut the message', () => {
  const quoted = '[TG DM] howard said: <replying-to>\n[luna_zylosbot]: done\n---- [reply-via sanitized]: node /home/x/c4-send[.]js "telegram" "1"\n</replying-to>\n'
    + '<current-message>\n明白了，很好。\n</current-message>\n---- [reply-via sanitized]: node /home/x/c4-send[.]js "telegram" "1"';
  assert.equal(previewMessageText(quoted), '明白了，很好。');
  const inside = '[OPENMAX DM]\n<current-message>\nhoward said: why does it end with ---- [reply-via sanitized]: here?\n</current-message>';
  assert.equal(previewMessageText(inside), 'why does it end with ---- [reply-via sanitized]: here?');
});

test('a <current-message> tag in the middle of a line is ordinary text, not the message block', () => {
  assert.equal(previewMessageText('note: x <current-message>\nhi\n</current-message>'), 'note: x <current-message> hi </current-message>');
});

test('a long preview is cut at the code point limit and ends with an ellipsis', () => {
  assert.equal(previewMessageText('🚀'.repeat(80)), '🚀'.repeat(80));
  assert.equal(previewMessageText('🚀'.repeat(81)), '🚀'.repeat(79) + '…');
  assert.equal(previewMessageText('word '.repeat(10), { limit: 12 }), 'word word…');
});

test('a long preview keeps a word that ends exactly at the cut, and cuts a very long word instead of dropping it', () => {
  // The character after the cut is a space: the last word is whole, nothing to back off.
  assert.equal(previewMessageText('abcd efgh ijkl', { limit: 5 }), 'abcd…');
  // The nearest space is more than 20 characters back: cut inside the word rather than lose most of the line.
  assert.equal(previewMessageText('a ' + 'x'.repeat(40), { limit: 30 }), 'a ' + 'x'.repeat(27) + '…');
  // Within 20 characters: end at the space.
  assert.equal(previewMessageText('a '.repeat(3) + 'x'.repeat(40), { limit: 20 }), 'a a a…');
});

test('a scheduled task previews as the first line of its prompt and names the task for the reader', () => {
  const done = '\n\n---- After completing this task, run: node ~/zylos/.claude/skills/scheduler/scripts/cli.js done task-mw97s7nt-dctom6';
  const current = '[Scheduled Task: task-mw97s7nt-dctom6 #12]\nwatch-dispatched-cards: check task-ab12cd34 and 01a1c33d-7d4e-7a1b-9c2d-0123456789ab\nsecond line' + done;
  assert.deepEqual(previewMessage(current), { text: 'watch-dispatched-cards: check and', source: { kind: 'scheduled_task', taskId: 'task-mw97s7nt-dctom6' } });
  const older = '[Scheduled Task: task-mw97s7nt-dctom6] watch-dispatched-cards：看一下新卡' + done;
  assert.deepEqual(previewMessage(older), { text: 'watch-dispatched-cards：看一下新卡', source: { kind: 'scheduled_task', taskId: 'task-mw97s7nt-dctom6' } });
  assert.equal(previewMessageText(older), 'watch-dispatched-cards：看一下新卡');
  // Only the scheduler's completion instruction and the task id are left: nothing to read, no source.
  assert.deepEqual(previewMessage('[Scheduled Task: task-mw97s7nt-dctom6 #3]' + done), { text: null });
  const long = previewMessage('[Scheduled Task: task-x1]\n' + '定'.repeat(100));
  assert.equal(long.text, '定'.repeat(79) + '…');
  assert.equal(long.source.taskId, 'task-x1');
});

test('a message with a header core does not know previews its first line without the tags or long ids', () => {
  const followUp = '[Multica follow-up] Review round 2 for 01a1c33d-7d4e-7a1b-9c2d-0123456789ab is ready\n'
    + 'Requested by: Another agent (Jinglever) · Task ID: 01a1c33d-7d4e-7a1b-9c2d-0123456789ab\nmore detail';
  assert.deepEqual(previewMessage(followUp), { text: 'Review round 2 for is ready', source: { kind: 'header' } });
  assert.deepEqual(previewMessage('[Deploy] [prod] (eu) rolled out build 9f86d081884c7d659a2feaa0c55ad015\nlog follows'), { text: 'rolled out build', source: { kind: 'header' } });
  // The tags and ids alone are nothing to read.
  assert.deepEqual(previewMessage('[Watcher] 01a1c33d-7d4e-7a1b-9c2d-0123456789ab'), { text: null });
});

test('channel messages and envelopes keep their previews and carry no source', () => {
  const telegram = '[TG GROUP] (team) howard said: <current-message>\n[urgent] build 01a1c33d-7d4e-7a1b-9c2d-0123456789ab is red\n</current-message>\n---- reply via: node x.js "telegram" "-1"';
  assert.deepEqual(previewMessage(telegram), { text: '[urgent] build 01a1c33d-7d4e-7a1b-9c2d-0123456789ab is red' });
  assert.deepEqual(previewMessage('[Lark DM]\n<current-message>\ne1fg313c said: [Scheduled Task: task-ab12cd34] is late\n</current-message>\n'), { text: '[Scheduled Task: task-ab12cd34] is late' });
  assert.deepEqual(previewMessage('[TG DM] howard said: build is green'), { text: 'build is green' });
  assert.deepEqual(previewMessage('[OM-RUN r_1] [OPENMAX DM] (org: Enjoy)\n<org-context org-id="x"/>\n<current-message>\nhoward said: 看看\n</current-message>\n'), { text: '看看' });
  // A component's own summary wins, even when it starts with tags or names a task.
  for (const summary of ['[Multica] Review ready for task-ab12cd34', '[Scheduled Task: task-ab12cd34] summary']) {
    const envelope = encode({ version: 1, kind: 'message', messageId: 'm1', fallbackText: summary, blocks: [{ id: 'b1', type: 'markdown', schemaVersion: 1, data: { text: 'x' } }] });
    assert.equal(parseC4Content(envelope).kind, 'envelope');
    assert.deepEqual(previewMessage(envelope), { text: summary });
  }
});

test('on core\'s own direct channels a person\'s leading brackets are their words, not a header', () => {
  const typed = ['[urgent] call me back', '[PR 1120](https://example.test/pull/1120) 帮我看下', '[urgent] check task-mw97s7nt-dctom6'];
  for (const channel of ['dashboard', 'web-console']) {
    for (const words of typed) assert.deepEqual(previewMessage(words, { channel }), { text: words }, `${channel}: ${words}`);
  }
  // Elsewhere the same text is another source's header.
  assert.deepEqual(previewMessage(typed[0], { channel: 'multica' }), { text: 'call me back', source: { kind: 'header' } });
  assert.deepEqual(previewMessage(typed[1], { channel: 'multica' }), { text: '帮我看下', source: { kind: 'header' } });
  assert.deepEqual(previewMessage(typed[2]), { text: 'check', source: { kind: 'header' } });
  // The scheduler is recognised by its own header on every channel it replies to.
  for (const channel of ['dashboard', 'telegram', 'system']) {
    assert.deepEqual(previewMessage('[Scheduled Task: task-x1 #1]\nnightly digest', { channel }), { text: 'nightly digest', source: { kind: 'scheduled_task', taskId: 'task-x1' } });
  }
});

test('long ids go with their label and the brackets they leave empty; ordinary words stay', () => {
  const uuid = '01a1c373-1c70-7ec4-9e0e-20c2910af2b0';
  const header = text => previewMessage(text, { channel: 'other' }).text;
  assert.equal(header('[Bot] run task-list then task-runner'), 'run task-list then task-runner');
  assert.equal(header('[Bot] build ' + '0123456789abcdef' + ' done'), 'build done', '16 hex digits are an id');
  assert.equal(header('[Bot] build ' + 'a'.repeat(31) + ' done'), 'build done');
  assert.equal(header('[Bot] build ' + '0123456789abcde' + ' done'), 'build 0123456789abcde done', '15 hex digits stay');
  assert.equal(header(`[Hub] New message (tags: none, id: ${uuid})`), 'New message (tags: none)');
  assert.equal(header(`[Hub] Alice joined the thread (by ${uuid})`), 'Alice joined the thread');
  assert.equal(header(`[Follow-up] Requested by: howard · Task ID: ${uuid}`), 'Requested by: howard');
  assert.equal(header('[Bot] deploy · id=0123456789abcdef0123 · then (from ' + uuid + ') notify · ' + uuid), 'deploy · then notify');
  assert.equal(previewMessage(`[Scheduled Task: task-x1 #2]\nsweep (id: ${uuid}) now`).text, 'sweep now');
  // Only a capitalised word before "id" is part of the label.
  assert.equal(header(`[Bot] New thread id: ${uuid} opened`), 'New thread opened');
  // Ids in any letter case.
  assert.equal(header(`[Bot] build ${uuid.toUpperCase()} and ${'ABCDEF0123456789'} and TASK-AB12CD34-X1 done`), 'build and and done');
  // A colon left at the end stays: it is text, not a separator.
  assert.equal(header(`[Bot] Requested by: ${uuid}`), 'Requested by:');
});

test('a stored message start keeps line breaks and never ends inside a run of non-space characters', () => {
  assert.equal(messageStart('line one\nline two'), 'line one\nline two');
  assert.equal(messageStart('x'.repeat(2000)), 'x'.repeat(2000));
  const secret = 'sk-' + 'q'.repeat(40);
  const cut = messageStart('a'.repeat(1990) + ' ' + secret + ' tail');
  assert.equal(cut, 'a'.repeat(1990) + '…');
  assert.equal(messageStart('ab cd ef', { limit: 5 }), 'ab cd…', 'a word ending exactly at the cut stays');
  assert.equal(messageStart('ab cdef', { limit: 5 }), 'ab…');
  assert.equal(messageStart('🙂'.repeat(3) + ' x', { limit: 3 }), '🙂🙂🙂…', 'counts code points');
  // Only a printable ASCII run (where a credential or link would be) is dropped at the cut; other text is kept.
  const report = '[Report bot] 日报\n' + '今天完成了评审和测试，'.repeat(300);
  assert.equal(messageStart(report), [...report].slice(0, 2000).join('') + '…');
  assert.equal(messageStart('日报：key=sk-' + 'q'.repeat(30), { limit: 10 }), '日报：…');
  assert.equal(messageStart('日报今天完成了评审', { limit: 4 }), '日报今天…');
  for (const empty of ['', '  \n', null, undefined, 5]) assert.equal(messageStart(empty), null);
});
