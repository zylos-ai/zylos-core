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
  assert.equal(parseC4Content(text).kind, 'invalid');
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

test('error lookup agrees with the parser on every protocol fixture and component example', () => {
  const valid = [...fixtures.valid.map(item => item.content), ...COMPONENT_DEFINITIONS.map(item => content(item.example))];
  for (const text of valid) {
    assert.equal(parseC4Content(text).kind, 'envelope');
    assert.equal(findC4ContentError(text), null);
  }
  for (const item of fixtures.invalid) {
    assert.equal(parseC4Content(item.content).kind, 'invalid', item.name);
    const error = findC4ContentError(item.content);
    assert.ok(error && error.code && typeof error.path === 'string', item.name);
  }
});
