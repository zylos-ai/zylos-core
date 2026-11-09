import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONTENT_PREFIX, COMPONENT_DEFINITIONS, parseC4Content, findC4ContentError, formatC4ContentError,
  describeC4ContentRejection, normalizeHookMessage } from '../c4-content-schema.js';

// Pure schema checks: no files besides the shared fixture, no DB, HTTP, PM2 or tmux.
const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const example = key => structuredClone(COMPONENT_DEFINITIONS.find(item => item.key === key).example);
const content = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
const choice = change => { const envelope = example('choice@1'); change(envelope); return content(envelope); };

function rejectsAt(text, code, path) {
  assert.equal(parseC4Content(text, { submission: true }).kind, 'invalid');
  const error = findC4ContentError(text);
  assert.deepEqual({ code: error.code, path: error.path }, { code, path });
  assert.equal(typeof error.message, 'string');
  const hint = describeC4ContentRejection(text);
  assert.equal(hint, formatC4ContentError(error));
  assert.ok(hint.startsWith(`${path || '(root)'} [${code}] `), hint);
  assert.equal(normalizeHookMessage('Invalid Dashboard structured content: ' + hint), 'Invalid Dashboard structured content: ' + hint);
  return hint;
}

test('a block without schemaVersion is reported at the missing member', () => {
  rejectsAt(choice(envelope => { delete envelope.blocks[0].schemaVersion; }), 'required', '/blocks/0/schemaVersion');
});

test('a misspelled action type is reported at the action type without repeating it', () => {
  const hint = rejectsAt(choice(envelope => { envelope.blocks[0].data.action.type = 'choice.private_value'; }),
    'enum', '/blocks/0/data/action/type');
  assert.equal(hint.includes('choice.private_value'), false);
  assert.match(hint, /"choice\.select"/);
});

test('an action target with capitals is reported at the target', () => {
  const hint = rejectsAt(choice(envelope => { envelope.blocks[0].data.action.target = 'Private.Target'; }),
    'pattern', '/blocks/0/data/action/target');
  assert.equal(hint.includes('Private.Target'), false);
});

test('an option label over the limit is reported at that label with the limit', () => {
  const hint = rejectsAt(choice(envelope => { envelope.blocks[0].data.options[1].label = 'x'.repeat(121); }),
    'maxLength', '/blocks/0/data/options/1/label');
  assert.match(hint, /at most 120 characters/);
});

test('an unknown block type is reported at the type without repeating it', () => {
  const hint = rejectsAt(choice(envelope => { envelope.blocks[0].type = 'private_widget'; }), 'enum', '/blocks/0/type');
  assert.equal(hint.includes('private_widget'), false);
  assert.match(hint, /"markdown"/);
});

test('an unexpected property is reported at its object without naming the submitted key', () => {
  const marker = 'private_key_do_not_echo';
  const hint = rejectsAt(choice(envelope => { envelope.blocks[0].data[marker] = marker; }), 'additionalProperties', '/blocks/0/data');
  assert.equal(hint.includes(marker), false);
  assert.match(hint, /allowed properties: prompt, options/);
  const top = rejectsAt(choice(envelope => { envelope[marker] = 1; }), 'additionalProperties', '');
  assert.equal(top.includes(marker), false);
});

test('envelope question members are reported at their own paths', () => {
  rejectsAt(choice(envelope => { delete envelope.questionSummary; }), 'required', '/questionSummary');
  const hint = rejectsAt(choice(envelope => { envelope.interrupt.reason = 'private_reason'; }), 'enum', '/interrupt/reason');
  assert.equal(hint.includes('private_reason'), false);
  rejectsAt(choice(envelope => { envelope.interrupt.reason = 'confirmation'; }), 'const', '/interrupt/reason');
  rejectsAt(choice(envelope => { envelope.interrupt.blockId = 'missing'; }), 'interactiveBlock', '/interrupt/blockId');
  rejectsAt(choice(envelope => { envelope.questionSummary = 'private summary'; }), 'derivedSummary', '/questionSummary');
});

test('a duplicate block ID is reported at the later block', () => {
  rejectsAt(choice(envelope => {
    envelope.blocks.push({ id: envelope.blocks[0].id, type: 'markdown', schemaVersion: 1, data: { text: 'more' } });
  }), 'uniqueBlockId', '/blocks/1/id');
});

test('a submitted form value is reported at the values object without its key', () => {
  const envelope = structuredClone(fixtures.valid.find(item => item.name === 'answer_form_submit').envelope);
  envelope.action.payload.values.private_key = { nested: true };
  const hint = rejectsAt(content(envelope), 'anyOf', '/action/payload/values');
  assert.equal(hint.includes('private_key'), false);
});

test('a duplicate v2 form field key is reported by position', () => {
  const envelope = example('form_intent@2');
  const fields = envelope.blocks[0].data.fields;
  fields.push({ ...fields[0] });
  const hint = rejectsAt(content(envelope), 'duplicate_form_field', `/blocks/0/data/fields/${fields.length - 1}/key`);
  assert.equal(hint.includes(`"${fields[0].key}"`), false);
});

test('framing failures and unmarked text have root paths', () => {
  rejectsAt(CONTENT_PREFIX + '{"private"', 'invalid_json', '');
  rejectsAt(content(example('markdown@1')) + ' private tail', 'invalid_suffix', '');
  assert.deepEqual(findC4ContentError('plain text').code, 'marker');
});

test('activeWhen naming a missing field is reported at its field member', () => {
  const envelope = example('form_intent@2');
  envelope.blocks[0].data.fields[1].activeWhen.field = 'absent_field';
  const hint = rejectsAt(content(envelope), 'unknown_condition_field', '/blocks/0/data/fields/1/activeWhen/field');
  assert.equal(hint.includes('absent_field'), false);
});

test('block data depth and block node limits are reported with their own codes', () => {
  const nested = depth => depth === 0 ? 'x' : { level: nested(depth - 1) };
  const deep = example('form_intent@1');
  deep.blocks[0].data.state = { status: 'resolved', resolvedAt: '2026-11-07T00:00:00Z', values: { value: nested(4) } };
  delete deep.interruptId; delete deep.questionSummary; delete deep.interrupt;
  rejectsAt(content(deep), 'maxDepth', '/blocks/0/data');
  const large = example('markdown@1');
  large.blocks = [{ id: 'text', type: 'markdown', schemaVersion: 1, data: { text: 'x' }, metadata: { host: { nodes: Array(4992).fill(null) } } }];
  rejectsAt(content(large), 'maxNodes', '/blocks/0');
});

test('an interrupted block that is pending or closed is reported at its status', () => {
  rejectsAt(choice(envelope => { envelope.blocks[0].status = 'pending'; }), 'const', '/blocks/0/status');
  rejectsAt(choice(envelope => { envelope.blocks[0].data.state = { status: 'expired' }; }), 'const', '/blocks/0/data/state/status');
});

// Send-time consistency checks: stored history still parses, new sends are
// rejected at the inconsistent member.
function rejectsOnlyWhenSent(text, code, path) {
  assert.equal(parseC4Content(text).kind, 'envelope');
  assert.equal(parseC4Content(text, { submission: true }).kind, 'invalid');
  return rejectsAt(text, code, path);
}
const sentRejection = (key, change, code, path) => {
  const envelope = example(key);
  change(envelope.blocks[0].data);
  return rejectsOnlyWhenSent(content(envelope), code, path);
};

test('choice option IDs and selection bounds are reported at the inconsistent member', () => {
  sentRejection('choice@1', data => { data.options[1].id = data.options[0].id; }, 'uniqueOptionId', '/blocks/0/data/options/1/id');
  sentRejection('choice@1', data => { data.minSelect = 0; }, 'minimum', '/blocks/0/data/minSelect');
  sentRejection('choice@1', data => { data.selection = 'multiple'; data.minSelect = 3; }, 'selectionBounds', '/blocks/0/data/minSelect');
  sentRejection('choice@1', data => { data.selection = 'multiple'; data.minSelect = 2; data.maxSelect = 1; },
    'selectionBounds', '/blocks/0/data/maxSelect');
  sentRejection('choice@1', data => { data.minSelect = 2; }, 'selectionBounds', '/blocks/0/data/minSelect');
});

for (const key of ['form_intent@1', 'form_intent@2']) test(`${key} field definitions are reported by field position`, () => {
  const select = key === 'form_intent@1' ? 2 : 0, text = key === 'form_intent@1' ? 0 : 1;
  const base = `/blocks/0/data/fields`;
  sentRejection(key, data => { data.fields[select].options[1].id = data.fields[select].options[0].id; },
    'uniqueOptionId', `${base}/${select}/options/1/id`);
  sentRejection(key, data => { data.fields[text].options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]; },
    'optionsNotAllowed', `${base}/${text}/options`);
  sentRejection(key, data => { data.fields[text].max = 3; }, 'boundsNotAllowed', `${base}/${text}/max`);
  const hint = sentRejection(key, data => { data.fields[select].defaultValue = 'private_default'; },
    'invalidDefault', `${base}/${select}/defaultValue`);
  assert.equal(hint.includes('private_default'), false);
  sentRejection(key, data => { data.fields[text].defaultValue = null; }, 'invalidDefault', `${base}/${text}/defaultValue`);
});

test('numeric field bounds in the wrong order are reported at max', () => {
  sentRejection('form_intent@1', data => { data.fields[1].min = 6; }, 'boundsOrder', '/blocks/0/data/fields/1/max');
});

test('a repeated v1 form field key is reported at the later field', () => {
  sentRejection('form_intent@1', data => { data.fields[2].key = data.fields[0].key; delete data.fields[2].options;
    data.fields[2].type = 'text'; }, 'duplicate_form_field', '/blocks/0/data/fields/2/key');
});

test('error lookup agrees with the send-time parser on every protocol fixture and component example', () => {
  const texts = [...fixtures.valid.map(item => item.content), ...fixtures.invalid.map(item => item.content),
    ...COMPONENT_DEFINITIONS.map(item => content(item.example))];
  let accepted = 0;
  for (const text of texts) {
    const sent = parseC4Content(text, { submission: true }).kind === 'envelope';
    assert.equal(findC4ContentError(text) === null, sent);
    accepted += sent;
  }
  assert.equal(accepted, fixtures.valid.length + COMPONENT_DEFINITIONS.length);
});
