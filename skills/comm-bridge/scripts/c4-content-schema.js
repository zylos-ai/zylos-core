/*
Protocol constraints adapted from zz-howard/chatweave @ 5c4288338e2a6a50c236d06e51e346c080ae7141,
schemas/v0.1/content-block.schema.json and action.schema.json.

MIT License

Copyright (c) 2026 Howard Zhou

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
export const CONTENT_PREFIX = '[C4-JSON]\n';
export const MAX_CONTENT_BYTES = 65536;
const encoder = new TextEncoder();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const chars = value => [...value].length;
const string = (value, minimum = 0, maximum = Infinity) => typeof value === 'string' && chars(value) >= minimum && chars(value) <= maximum;
const keys = (value, required, optional = []) => object(value)
  && required.every(key => own(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const byteLength = value => encoder.encode(value).byteLength;
const whitespace = /^[ \t\r\n]*$/;

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function dateTime(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  return !!match && date(match[1]) && +match[2] < 24 && +match[3] < 60 && +match[4] <= 60
    && (!match[5] || (+match[6] < 24 && +match[7] < 60));
}
function formatValid(name, value) {
  if (name === 'date') return date(value);
  if (name === 'date-time') return dateTime(value);
  if (name === 'uri') { try { return !!new URL(value).protocol; } catch { return false; } }
  return false;
}
function typeValid(type, value) {
  if (type === 'object') return object(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}
function reference(ref, document) {
  const [name, pointer = ''] = ref.split('#');
  const source = name === 'action.schema.json' ? ACTION_SCHEMA : name === 'content-block.schema.json' ? BLOCK_SCHEMA : document;
  return { document: source, schema: pointer.split('/').slice(1).reduce((value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], source) };
}
// A rejection is {code, path, message}: code names the failing schema keyword
// or host rule, path is a JSON Pointer to the failing value and message is
// fixed text built from the schema or rule only. Paths are made of schema
// member names and array positions, which never contain "~" or "/". A member
// reached through additionalProperties has a submitted key, so the path stops
// at its parent object. Callers that only need a boolean pass `at = null`:
// failures then return one shared value without building paths or text.
const QUIET_FAILURE = Object.freeze({ code: 'invalid', path: '', message: 'is invalid' });
const HIDDEN_MEMBER = Symbol('hidden member');
const list = values => values.map(value => JSON.stringify(value)).join(', ');
function pointer(segments, child) {
  let path = '';
  for (const segment of segments) {
    if (segment === HIDDEN_MEMBER) return path;
    path += '/' + segment;
  }
  return child === undefined ? path : path + '/' + child;
}
const failAt = (at, segments, code, message) => at ? { code, path: pointer([...at, ...segments]), message } : QUIET_FAILURE;
const within = (at, ...segments) => at && [...at, ...segments];
function keywordMessage(code, schema) {
  switch (code) {
    case 'const': return `must be ${JSON.stringify(schema.const)}`;
    case 'enum': return `must be one of ${list(schema.enum)}`;
    case 'type': return `must be of type ${[schema.type].flat().join(' or ')}`;
    case 'finite': return 'must be a finite number';
    case 'minLength': return `must contain at least ${schema.minLength} characters`;
    case 'maxLength': return `must contain at most ${schema.maxLength} characters`;
    case 'pattern': return `must match the pattern ${schema.pattern}`;
    case 'format': return `must be a valid ${schema.format} string`;
    case 'minimum': return `must be at least ${schema.minimum}`;
    case 'maximum': return `must be at most ${schema.maximum}`;
    case 'required': return 'is required';
    case 'minProperties': return `must contain at least ${schema.minProperties} properties`;
    case 'maxProperties': return `must contain at most ${schema.maxProperties} properties`;
    case 'propertyNames': return 'contains a property name that is not allowed';
    case 'additionalProperties': return 'contains a property that is not allowed'
      + (schema.properties ? `; allowed properties: ${Object.keys(schema.properties).join(', ')}` : '');
    case 'minItems': return `must contain at least ${schema.minItems} items`;
    case 'maxItems': return `must contain at most ${schema.maxItems} items`;
    case 'uniqueItems': return 'must not contain duplicate items';
    case 'anyOf': return 'does not match any allowed form';
    case 'oneOf': return 'must match exactly one allowed form';
    case 'not': return 'combines properties or values that are not allowed together';
    default: return 'is not allowed here';
  }
}
function keywordFailure(at, code, schema, child) {
  return at ? { code, path: pointer(at, child), message: keywordMessage(code, schema) } : QUIET_FAILURE;
}
// Internal interpreter for the fixed, embedded schema subset below. It is not
// a public or general-purpose JSON Schema evaluator and never evaluates code.
// Returns null when the value matches, otherwise the first failure in
// evaluation order. Subschemas used only as conditions or alternatives
// (if, not, anyOf, oneOf, propertyNames) are always evaluated quietly.
function schemaFailure(schema, value, document, at) {
  if (typeof schema === 'boolean') return schema ? null : keywordFailure(at, 'false', schema);
  if (!object(schema)) return keywordFailure(at, 'schema', schema);
  let failure;
  if (schema.$ref) {
    const ref = reference(schema.$ref, document);
    if ((failure = schemaFailure(ref.schema, value, ref.document, at))) return failure;
  }
  if (own(schema, 'const') && value !== schema.const) return keywordFailure(at, 'const', schema);
  if (schema.enum && !schema.enum.includes(value)) return keywordFailure(at, 'enum', schema);
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => typeValid(type, value))) return keywordFailure(at, 'type', schema);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && chars(value) < schema.minLength) return keywordFailure(at, 'minLength', schema);
    if (schema.maxLength !== undefined && chars(value) > schema.maxLength) return keywordFailure(at, 'maxLength', schema);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return keywordFailure(at, 'pattern', schema);
    if (schema.format && !formatValid(schema.format, value)) return keywordFailure(at, 'format', schema);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return keywordFailure(at, 'finite', schema);
    if (schema.minimum !== undefined && value < schema.minimum) return keywordFailure(at, 'minimum', schema);
    if (schema.maximum !== undefined && value > schema.maximum) return keywordFailure(at, 'maximum', schema);
  }
  if (object(value)) {
    const missing = schema.required?.find(key => !own(value, key));
    if (missing !== undefined) return keywordFailure(at, 'required', schema, missing);
    const names = Object.keys(value);
    if (schema.maxProperties !== undefined && names.length > schema.maxProperties) return keywordFailure(at, 'maxProperties', schema);
    if (schema.minProperties !== undefined && names.length < schema.minProperties) return keywordFailure(at, 'minProperties', schema);
    for (const name of names) {
      if (schema.propertyNames && schemaFailure(schema.propertyNames, name, document, null)) return keywordFailure(at, 'propertyNames', schema);
      if (schema.properties && own(schema.properties, name)) {
        if ((failure = schemaFailure(schema.properties[name], value[name], document, within(at, name)))) return failure;
      } else if (schema.additionalProperties === false) return keywordFailure(at, 'additionalProperties', schema);
      else if (object(schema.additionalProperties)
        && (failure = schemaFailure(schema.additionalProperties, value[name], document, within(at, HIDDEN_MEMBER)))) return failure;
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return keywordFailure(at, 'minItems', schema);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return keywordFailure(at, 'maxItems', schema);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return keywordFailure(at, 'uniqueItems', schema);
    if (schema.items) {
      for (let index = 0; index < value.length; index++) {
        if ((failure = schemaFailure(schema.items, value[index], document, within(at, index)))) return failure;
      }
    }
  }
  if (schema.allOf) {
    for (const item of schema.allOf) if ((failure = schemaFailure(item, value, document, at))) return failure;
  }
  if (schema.anyOf && !schema.anyOf.some(item => !schemaFailure(item, value, document, null))) return keywordFailure(at, 'anyOf', schema);
  if (schema.oneOf && schema.oneOf.filter(item => !schemaFailure(item, value, document, null)).length !== 1) return keywordFailure(at, 'oneOf', schema);
  if (schema.not && !schemaFailure(schema.not, value, document, null)) return keywordFailure(at, 'not', schema);
  if (schema.if) {
    const branch = schemaFailure(schema.if, value, document, null) ? schema.else : schema.then;
    if (branch !== undefined && (failure = schemaFailure(branch, value, document, at))) return failure;
  }
  return null;
}
const matches = (schema, value, document) => schemaFailure(schema, value, document, null) === null;
/** Returns the first limit block data exceeds, or null. */
function dataLimitFailure(value) {
  const queue = [{ value, depth: 1 }];
  let nodes = 0;
  while (queue.length) {
    const item = queue.pop();
    if (++nodes > 5000) return 'maxNodes';
    if (item.depth > 6) return 'maxDepth';
    if (object(item.value) || Array.isArray(item.value)) {
      for (const child of Object.values(item.value)) queue.push({ value: child, depth: item.depth + 1 });
    }
  }
  return byteLength(JSON.stringify(value)) <= 65536 ? null : 'maxBytes';
}
const DATA_LIMIT_MESSAGES = {
  maxNodes: 'must contain at most 5000 JSON nodes',
  maxDepth: 'must nest at most 6 levels deep, counting data itself as 1',
  maxBytes: 'must serialize to at most 65536 UTF-8 bytes',
};
function withinMetadataDepth(value) {
  const stack = [{ value, depth: 1 }];
  while (stack.length) {
    const item = stack.pop();
    if (item.depth > 6) return false;
    if (object(item.value) || Array.isArray(item.value)) {
      for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}
function boundedBlockNodes(block) {
  const queue = [block]; let nodes = 0;
  while (queue.length) {
    const value = queue.pop();
    if (++nodes > 5000) return false;
    if (object(value) || Array.isArray(value)) queue.push(...Object.values(value));
  }
  return true;
}
const present = value => value != null && (typeof value !== 'string' || /[^\s\p{Default_Ignorable_Code_Point}]/u.test(value))
  && (!Array.isArray(value) || value.length > 0);
/** First repeated option ID position, or -1. */
const repeatedOption = options => options.findIndex((option, index) => options.findIndex(other => other.id === option.id) !== index);
/** Submission-time consistency of one form field definition; null when valid. */
function fieldDefinitionFailure(field, at) {
  const select = ['single_select', 'multi_select'].includes(field.type);
  if (select) {
    const index = repeatedOption(field.options);
    if (index >= 0) return failAt(at, ['options', index, 'id'], 'uniqueOptionId', 'must be unique within the field');
  } else if (own(field, 'options')) {
    return failAt(at, ['options'], 'optionsNotAllowed', 'is allowed only on single_select and multi_select fields');
  }
  if (!['number', 'integer'].includes(field.type)) {
    const bound = ['min', 'max'].find(key => own(field, key));
    if (bound) return failAt(at, [bound], 'boundsNotAllowed', 'is allowed only on number and integer fields');
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    return failAt(at, ['max'], 'boundsOrder', 'must not be less than min');
  }
  if (own(field, 'defaultValue') && (field.defaultValue === null || !validFieldValue({ ...field, required: false }, field.defaultValue))) {
    return failAt(at, ['defaultValue'], 'invalidDefault', 'must be a value this field accepts');
  }
  return null;
}
const validFieldDefinition = field => fieldDefinitionFailure(field, null) === null;
const FORM_DEFINITION_MESSAGES = {
  invalid_form_fields: 'must contain 1 to 12 fields',
  invalid_form_field: 'does not match the form field schema',
  duplicate_form_field: 'must be unique within the form',
  unknown_condition_field: 'must name another field of this form',
  condition_type: 'must compare a single-value field with constants of that field type',
  form_condition_cycle: 'must not make fields depend on each other in a cycle',
};
// evaluateFormState reports field-specific errors as `<reason>:<key>`; locate
// the field by position so the key itself is not repeated.
function formDefinitionFailure(fields, reason, at, historical) {
  if (!at) return QUIET_FAILURE;
  const [code, key] = reason.split(':');
  const message = FORM_DEFINITION_MESSAGES[code] ?? 'is not a valid form definition';
  if (code === 'invalid_form_field') {
    for (let index = 0; index < fields.length; index++) {
      const fieldAt = [...at, 'data', 'fields', index];
      const failure = schemaFailure(BLOCK_SCHEMA.$defs.formFieldV2, fields[index], BLOCK_SCHEMA, fieldAt)
        ?? (historical ? null : fieldDefinitionFailure(fields[index], fieldAt));
      if (failure) return failure;
    }
  }
  if (key === undefined) return failAt(at, ['data', 'fields'], code, message);
  if (code === 'duplicate_form_field') {
    const index = fields.findIndex((field, position) => fields.findIndex(other => other.key === field.key) !== position);
    return failAt(at, ['data', 'fields', index, 'key'], code, message);
  }
  const index = fields.findIndex(field => field.key === key);
  return failAt(at, ['data', 'fields', index, 'activeWhen', ...(code === 'unknown_condition_field' ? ['field'] : [])], code, message);
}
/** Checks that apply only to content being sent now; stored history skips them. */
function submissionBlockFailure(block, at) {
  const data = block.data;
  if (block.type === 'choice') {
    const index = repeatedOption(data.options);
    if (index >= 0) return failAt(at, ['data', 'options', index, 'id'], 'uniqueOptionId', 'must be unique within the choice');
    const minimum = data.minSelect ?? 1, maximum = data.maxSelect ?? data.options.length;
    if (minimum < 1) return failAt(at, ['data', 'minSelect'], 'minimum', 'must be at least 1');
    if (minimum > data.options.length) return failAt(at, ['data', 'minSelect'], 'selectionBounds', 'must not exceed the number of options');
    if (minimum > maximum) return failAt(at, ['data', 'maxSelect'], 'selectionBounds', 'must not be less than minSelect (1 when omitted)');
    if ((data.selection ?? 'single') === 'single' && minimum > 1) {
      return failAt(at, ['data', 'minSelect'], 'selectionBounds', 'must be 1 or omitted for single selection');
    }
  }
  if (block.type === 'form_intent') {
    const fields = data.fields;
    const repeated = fields.findIndex((field, index) => fields.findIndex(other => other.key === field.key) !== index);
    if (repeated >= 0) return failAt(at, ['data', 'fields', repeated, 'key'], 'duplicate_form_field', FORM_DEFINITION_MESSAGES.duplicate_form_field);
    for (let index = 0; index < fields.length; index++) {
      const failure = fieldDefinitionFailure(fields[index], within(at, 'data', 'fields', index));
      if (failure) return failure;
    }
  }
  return null;
}
function diagramFailure(data, at) {
  const positions = new Map();
  for (let index = 0; index < data.steps.length; index++) {
    const id = data.steps[index].id;
    if (id === undefined) continue;
    if (positions.has(id)) return failAt(at, ['steps', index, 'id'], 'duplicate_diagram_step_id', 'must be unique within the diagram');
    positions.set(id, index);
  }
  const grouped = new Set();
  for (let index = 0; index < (data.groups?.length ?? 0); index++) {
    const group = data.groups[index];
    const from = positions.get(group.from), to = positions.get(group.to);
    if (from === undefined || to === undefined) {
      return failAt(at, ['groups', index, from === undefined ? 'from' : 'to'], 'invalid_diagram_group_endpoint', 'must identify an existing step');
    }
    if (from > to) return failAt(at, ['groups', index], 'invalid_diagram_group_order', 'from must not follow to in wire order');
    for (let step = from; step <= to; step++) {
      if (grouped.has(step)) return failAt(at, ['groups', index], 'overlapping_diagram_groups', 'must not share a step with another group');
      grouped.add(step);
    }
  }
  return null;
}
/** `submission` adds the send-time consistency checks; stored history omits them. */
function blockFailure(block, at, submission = false, allowUnknown = false) {
  const unknown = object(block) && typeof block.type === 'string' && !blockTypes.includes(block.type);
  const failure = schemaFailure(allowUnknown && unknown ? UNKNOWN_BLOCK_SCHEMA : BLOCK_SCHEMA, block, BLOCK_SCHEMA, at);
  if (failure) return failure;
  if (allowUnknown && unknown && !present(block.fallbackText)) return failAt(at, ['fallbackText'], 'required', 'must contain visible text');
  if (unknown && !allowUnknown) return failAt(at, ['type'], 'enum', `must be one of ${list(blockTypes)}`);
  if (!boundedBlockNodes(block)) return failAt(at, [], 'maxNodes', 'must contain at most 5000 JSON nodes');
  if (block.metadata?.provenance === 'adapter' && block.type !== 'markdown') {
    return failAt(at, ['metadata', 'provenance'], 'const', 'adapter provenance is allowed on markdown blocks only');
  }
  const limit = block.data ? dataLimitFailure(block.data) : null;
  if (limit) return failAt(at, ['data'], limit, DATA_LIMIT_MESSAGES[limit]);
  if (block.type === 'diagram' && block.data) {
    const failure = diagramFailure(block.data, within(at, 'data'));
    if (failure) return failure;
  }
  if (block.type === 'form_intent' && block.schemaVersion === 2 && block.data) {
    const [reason] = evaluateFormState(block.data.fields, {}, { historical: !submission }).errors;
    if (reason) return formDefinitionFailure(block.data.fields, reason, at, !submission);
  }
  if (submission && block.data) {
    const failure = submissionBlockFailure(block, at);
    if (failure) return failure;
  }
  if (block.type === 'markdown' && block.data && byteLength(block.data.text) > 32768) {
    return failAt(at, ['data', 'text'], 'maxBytes', 'must contain at most 32768 UTF-8 bytes');
  }
  return null;
}

/** Attachment rejection diagnostics only; does not validate a block/envelope. */
export function validateAttachmentData(data) {
  return matches(BLOCK_SCHEMA.$defs.attachmentData, data, BLOCK_SCHEMA);
}

export function normalizeHookMessage(value) {
  return typeof value === 'string' ? [...value.replace(/[\r\n\u2028\u2029]/gu, ' ')].slice(0, 500).join('') : '';
}
export function makeQuestionSummary(envelope) {
  const block = Array.isArray(envelope?.blocks) ? envelope.blocks.find(item => item.id === envelope.interrupt?.blockId) : null;
  const source = [block?.fallbackText, block?.data?.prompt, block?.data?.title, block?.data?.purpose, envelope?.fallbackText]
    .find(value => typeof value === 'string' && value.trim());
  return typeof source === 'string' ? [...source.replace(/\s+/gu, ' ').trim()].slice(0, 500).join('') : '';
}
function actionFailure(action, at) {
  const failure = schemaFailure(ACTION_SCHEMA.$defs.actionRequest, action, ACTION_SCHEMA, at);
  if (failure) return failure;
  return action.protocolVersion === '0.1' ? null : failAt(at, ['protocolVersion'], 'const', 'must be "0.1"');
}
const validAction = action => actionFailure(action, null) === null;
// Envelope members are checked procedurally; these helpers report them with
// the same {code, path, message} shape as the schema interpreter.
function membersFailure(value, required, optional, at) {
  if (!object(value)) return failAt(at, [], 'type', 'must be of type object');
  const missing = required.find(key => !own(value, key));
  if (missing !== undefined) return failAt(at, [missing], 'required', 'is required');
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    return failAt(at, [], 'additionalProperties', `contains a property that is not allowed; allowed properties: ${[...required, ...optional].join(', ')}`);
  }
  return null;
}
function textFailure(container, key, minimum, maximum, at) {
  if (!own(container, key)) return failAt(at, [key], 'required', 'is required');
  const value = container[key];
  if (typeof value !== 'string') return failAt(at, [key], 'type', 'must be of type string');
  if (chars(value) < minimum) return failAt(at, [key], 'minLength', `must contain at least ${minimum} characters`);
  if (chars(value) > maximum) return failAt(at, [key], 'maxLength', `must contain at most ${maximum} characters`);
  return null;
}
function idFailure(container, key, at) {
  if (!own(container, key)) return failAt(at, [key], 'required', 'is required');
  return id(container[key]) ? null : failAt(at, [key], 'pattern', 'must match the pattern ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$');
}
const first = (...checks) => {
  for (const check of checks) {
    const failure = check();
    if (failure) return failure;
  }
  return null;
};
const QUESTION_KEYS = ['interruptId', 'questionSummary', 'interrupt'];
const SUMMARY_MESSAGE = "must equal the interrupted block's derived summary: fallbackText, then prompt/title/purpose, then envelope fallbackText; normalize whitespace and keep at most 500 characters";
function questionFailure(envelope, at) {
  if (QUESTION_KEYS.every(key => !own(envelope, key))) return null;
  const missing = QUESTION_KEYS.find(key => !own(envelope, key));
  if (missing) return failAt(at, [missing], 'required', 'is required when the message asks a question');
  const interrupt = envelope.interrupt;
  const failure = first(() => idFailure(envelope, 'interruptId', at),
    () => textFailure(envelope, 'questionSummary', 1, 500, at),
    () => membersFailure(interrupt, ['blockId', 'reason'], ['otherInput'], within(at, 'interrupt')));
  if (failure) return failure;
  if (!['confirmation', 'input_required'].includes(interrupt.reason)) {
    return failAt(at, ['interrupt', 'reason'], 'enum', 'must be one of "confirmation", "input_required"');
  }
  if (own(interrupt, 'otherInput') && typeof interrupt.otherInput !== 'boolean') {
    return failAt(at, ['interrupt', 'otherInput'], 'type', 'must be of type boolean');
  }
  const index = envelope.blocks.findIndex(item => item.id === interrupt.blockId), block = envelope.blocks[index];
  if (!block || !interactive.includes(block.type)) {
    return failAt(at, ['interrupt', 'blockId'], 'interactiveBlock', `must identify a block of type ${list(interactive)} in this message`);
  }
  if ((block.status ?? 'complete') !== 'complete') return failAt(at, ['blocks', index, 'status'], 'const', 'must be "complete" for the interrupted block');
  if (!object(block.data)) return failAt(at, ['blocks', index, 'data'], 'required', 'is required for the interrupted block');
  if ((block.data.state?.status ?? 'open') !== 'open') {
    return failAt(at, ['blocks', index, 'data', 'state', 'status'], 'const', 'must be "open" for the interrupted block');
  }
  const reason = block.type === 'confirmation' ? 'confirmation' : 'input_required';
  if (interrupt.reason !== reason) return failAt(at, ['interrupt', 'reason'], 'const', `must be "${reason}" for a ${block.type} block`);
  return envelope.questionSummary === makeQuestionSummary(envelope) ? null : failAt(at, ['questionSummary'], 'derivedSummary', SUMMARY_MESSAGE);
}
function messageFailure(envelope, at, submission, allowUnknown) {
  let failure = membersFailure(envelope, ['version', 'kind', 'messageId', 'fallbackText', 'blocks'], ['metadata', ...QUESTION_KEYS], at);
  if (failure) return failure;
  const blocks = envelope.blocks;
  if (!Array.isArray(blocks)) return failAt(at, ['blocks'], 'type', 'must be of type array');
  if (blocks.length > 64) return failAt(at, ['blocks'], 'maxItems', 'must contain at most 64 items');
  for (let index = 0; index < blocks.length; index++) {
    if ((failure = blockFailure(blocks[index], within(at, 'blocks', index), submission, allowUnknown))) return failure;
  }
  const seen = new Set();
  for (let index = 0; index < blocks.length; index++) {
    if (seen.has(blocks[index].id)) return failAt(at, ['blocks', index, 'id'], 'uniqueBlockId', 'must be unique within the message');
    seen.add(blocks[index].id);
  }
  if (own(envelope, 'metadata')) {
    if (!object(envelope.metadata)) return failAt(at, ['metadata'], 'type', 'must be of type object');
    if (!withinMetadataDepth(envelope.metadata)) return failAt(at, ['metadata'], 'maxDepth', 'must nest at most 6 levels deep, counting metadata itself as 1');
  }
  return questionFailure(envelope, at);
}
function answerFailure(envelope, at) {
  const metadata = envelope.metadata;
  return first(
    () => membersFailure(envelope, ['version', 'kind', 'messageId', 'fallbackText', 'interruptId', 'questionSummary', 'action', 'metadata'], [], at),
    () => idFailure(envelope, 'interruptId', at),
    () => textFailure(envelope, 'questionSummary', 1, 500, at),
    () => actionFailure(envelope.action, within(at, 'action')),
    () => membersFailure(metadata, ['zylos'], [], within(at, 'metadata')),
    () => membersFailure(metadata.zylos, ['answerId'], [], within(at, 'metadata', 'zylos')),
    () => metadata.zylos.answerId === envelope.action.id ? null
      : failAt(at, ['metadata', 'zylos', 'answerId'], 'const', 'must equal action.id'));
}
function controlFailure(envelope, at) {
  const control = envelope.control, controlAt = within(at, 'control');
  return first(
    () => membersFailure(envelope, ['version', 'kind', 'messageId', 'fallbackText', 'interruptId', 'control'], [], at),
    () => idFailure(envelope, 'interruptId', at),
    () => object(control) ? null : failAt(at, ['control'], 'type', 'must be of type object'),
    () => idFailure(control, 'messageId', controlAt),
    () => control.operation === 'stop' ? membersFailure(control, ['operation', 'messageId'], [], controlAt)
      : control.operation === 'replace' ? membersFailure(control, ['operation', 'messageId', 'replacementInterruptId'], [], controlAt)
        || idFailure(control, 'replacementInterruptId', controlAt)
        : own(control, 'operation') ? failAt(controlAt, ['operation'], 'enum', 'must be one of "stop", "replace"')
          : failAt(controlAt, ['operation'], 'required', 'is required'));
}
/** First envelope failure, or null. Pass `at = null` for a boolean check;
 * `submission` adds the send-time block checks.
 */
function envelopeFailure(envelope, at, submission = false, allowUnknown = false) {
  if (!object(envelope)) return failAt(at, [], 'type', 'must be of type object');
  if (!own(envelope, 'version')) return failAt(at, ['version'], 'required', 'is required');
  if (envelope.version !== 1) return failAt(at, ['version'], 'const', 'must be 1');
  const failure = first(() => idFailure(envelope, 'messageId', at), () => textFailure(envelope, 'fallbackText', 1, 16000, at));
  if (failure) return failure;
  if (envelope.kind === 'message') return messageFailure(envelope, at, submission, allowUnknown);
  if (envelope.kind === 'answer') return answerFailure(envelope, at);
  if (envelope.kind === 'control') return controlFailure(envelope, at);
  return own(envelope, 'kind') ? failAt(at, ['kind'], 'enum', 'must be one of "message", "answer", "control"')
    : failAt(at, ['kind'], 'required', 'is required');
}
const validEnvelope = (envelope, submission = false, allowUnknown = false) => envelopeFailure(envelope, null, submission, allowUnknown) === null;

// View is presentation metadata. Validate the remaining envelope independently.
function splitMessageView(envelope) {
  if (!object(envelope) || envelope.kind !== 'message' || !object(envelope.metadata) || !own(envelope.metadata, 'view')) {
    return { envelope, hasView: false };
  }
  const metadata = { ...envelope.metadata };
  delete metadata.view;
  return { envelope: { ...envelope, metadata }, hasView: true, view: envelope.metadata.view,
    metadata: envelope.metadata };
}
function viewError(view, metadata, blocks) {
  if (!withinMetadataDepth(metadata)) return 'view_metadata_depth';
  if (!matches(VIEW_SCHEMA, view, VIEW_SCHEMA)) return 'invalid_view_schema';
  const nodes = new Map(view.nodes.map(node => [node.id, node]));
  if (nodes.size !== view.nodes.length) return 'duplicate_view_node';
  if (!nodes.has(view.root)) return 'missing_view_root';
  const blockIds = new Map(blocks.map(block => [block.id, block])), referenced = new Set(), parents = new Map();
  const children = node => node.type === 'section' ? [...(node.header ?? []), ...(node.body ?? []), ...(node.actions ?? [])]
    : node.type === 'block' ? [] : node.children;
  for (const node of nodes.values()) {
    if (node.type === 'block') {
      if (!blockIds.has(node.blockId)) return 'unknown_view_block';
      if ((blockIds.get(node.blockId).status ?? 'complete') !== 'complete') return 'incomplete_view_block';
      if (referenced.has(node.blockId)) return 'duplicate_view_block';
      referenced.add(node.blockId);
    }
    for (const child of children(node)) {
      if (!nodes.has(child)) return 'unknown_view_node';
      if (parents.has(child)) return 'multiple_view_parents';
      parents.set(child, node.id);
    }
  }
  if (parents.has(view.root)) return 'invalid_view_root_parent';
  const visited = new Set(), pending = [{ id: view.root, depth: 1 }];
  while (pending.length) {
    const next = pending.pop();
    if (next.depth > 6) return 'view_tree_depth';
    if (visited.has(next.id)) return 'view_cycle';
    visited.add(next.id);
    for (const child of children(nodes.get(next.id))) pending.push({ id: child, depth: next.depth + 1 });
  }
  return visited.size === nodes.size ? null : 'unreachable_view_node';
}

function jsonEnd(source, start) {
  if (source[start] !== '{') return -1;
  const stack = []; let quoted = false, escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return -1;
      if (!stack.length) return index + 1;
    }
  }
  return -1;
}
/** Read protocol framing only. The returned envelope is NOT schema-validated.
 * Intended for rejection hints before closed-schema validation; consumers must
 * use parseC4Content before accepting or acting on structured content.
 */
export function readC4Envelope(content) {
  if (typeof content !== 'string') return { kind: 'invalid', reason: 'content_type' };
  if (!content.startsWith(CONTENT_PREFIX)) return { kind: 'text', text: content };
  if (byteLength(content) > MAX_CONTENT_BYTES) return { kind: 'invalid', reason: 'content_too_large' };
  try {
    let start = CONTENT_PREFIX.length;
    while (start < content.length && /[ \t\r\n]/.test(content[start])) start++;
    const end = jsonEnd(content, start);
    if (end < 0) return { kind: 'invalid', reason: 'invalid_json' };
    let envelope;
    try { envelope = JSON.parse(content.slice(start, end)); }
    catch { return { kind: 'invalid', reason: 'invalid_json' }; }
    const tail = content.slice(end);
    const suffixMatch = /^[ \t\r\n]*(\n\n\[C4\] Status notification suppressed by cooldown while health=([^\n]*)\.)[ \t\r\n]*$/.exec(tail);
    if (!whitespace.test(tail)) {
      const fields = suffixMatch?.[2];
      const separator = fields?.indexOf(' reason=', 1) ?? -1;
      if (separator < 1 || separator + ' reason='.length >= fields.length) return { kind: 'invalid', reason: 'invalid_suffix' };
    }
    return { kind: 'envelope', envelope, suffix: suffixMatch?.[1] ?? '' };
  } catch { return { kind: 'invalid', reason: 'invalid_envelope' }; }
}

export function parseC4Content(content, { submission = false } = {}) {
  const framed = readC4Envelope(content);
  if (framed.kind !== 'envelope') return framed;
  const invalid = () => ({ kind: 'invalid', reason: 'invalid_envelope',
    ...(object(framed.envelope) && string(framed.envelope.fallbackText, 1, 16000)
      ? { fallbackText: framed.envelope.fallbackText } : {}) });
  try {
    const split = splitMessageView(framed.envelope);
    const allowUnknown = !submission && split.envelope?.kind === 'message'
      && QUESTION_KEYS.every(key => !own(split.envelope, key));
    if (!validEnvelope(split.envelope, submission, allowUnknown)) return invalid();
    const unsupportedBlocks = allowUnknown ? split.envelope.blocks.flatMap(block =>
      blockTypes.includes(block.type) ? [] : [{ id: block.id }]) : [];
    const error = split.hasView ? viewError(split.view, split.metadata, split.envelope.blocks) : null;
    return { kind: 'envelope', envelope: split.envelope, suffix: framed.suffix,
      view: split.hasView && !error ? split.view : null, ...(error ? { viewError: error } : {}),
      ...(unsupportedBlocks.length ? { unsupportedBlocks } : {}) };
  } catch { return invalid(); }
}

const FRAMING_MESSAGES = {
  content_type: 'content must be a string',
  content_too_large: 'content must not exceed 65536 UTF-8 bytes',
  invalid_json: 'expected one JSON object after the C4 marker',
  invalid_suffix: 'unexpected text follows the structured JSON object',
};
/**
 * First rejection point for content being sent, as {code, path, message}, or
 * null when parseC4Content(content, {submission: true}) accepts the envelope.
 * View metadata is checked separately (parseC4Content reports it as viewError). Content without the C4
 * marker is reported as code `marker`. path is a JSON Pointer into the
 * envelope ('' for the content itself); code is the failing schema keyword or
 * host rule. Paths and messages contain schema names, protocol limits and
 * array positions only, never submitted values or keys.
 */
export function findC4ContentError(content) {
  const framed = readC4Envelope(content);
  if (framed.kind === 'text') return { code: 'marker', path: '', message: 'content must start with the [C4-JSON] marker followed by a newline' };
  if (framed.kind !== 'envelope') {
    return { code: framed.reason, path: '', message: FRAMING_MESSAGES[framed.reason] ?? 'content must contain a JSON envelope' };
  }
  try { return envelopeFailure(splitMessageView(framed.envelope).envelope, [], true); }
  catch { return { code: 'invalid_envelope', path: '', message: 'envelope does not match the required schema' }; }
}
/** One line: `<JSON Pointer or (root)> [<code>] <message>.` */
export function formatC4ContentError(error) {
  return `${error.path || '(root)'} [${error.code}] ${error.message}.`;
}
/** Rejection hint for content the send-time parser rejected; the parser
 * remains the acceptance authority.
 */
export function describeC4ContentRejection(content) {
  return formatC4ContentError(findC4ContentError(content)
    ?? { code: 'invalid_envelope', path: '', message: 'envelope does not match the required message, answer or control schema' });
}

function validFieldValue(field, value, { historical = false } = {}) {
  if (!historical && field.required === true && !present(value)) return false;
  if (value == null) return field.required !== true;
  if (['text', 'multiline_text'].includes(field.type)) return string(value, 0, field.maxLength ?? 2000);
  if (['number', 'integer'].includes(field.type)) return typeof value === 'number' && Number.isFinite(value)
    && (field.type !== 'integer' || Number.isInteger(value)) && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'date') return date(value);
  if (field.type === 'datetime') return dateTime(value);
  if (field.type === 'single_select') return field.options.some(option => option.id === value);
  if (field.type === 'multi_select') return Array.isArray(value) && new Set(value).size === value.length && value.every(id => field.options.some(option => option.id === id));
  return false;
}
/** Evaluate active fields from the same definitions used by answer validation. */
export function evaluateFormState(fields, values, { historical = false } = {}) {
  const invalid = reason => ({ activeKeys: [], errors: [reason] });
  if (!Array.isArray(fields) || !fields.length || fields.length > 12) return invalid('invalid_form_fields');
  if (!object(values)) return invalid('invalid_form_values');
  const byKey = new Map();
  for (const field of fields) {
    if (!matches(BLOCK_SCHEMA.$defs.formFieldV2, field, BLOCK_SCHEMA)) return invalid('invalid_form_field');
    if (!historical && !validFieldDefinition(field)) return invalid('invalid_form_field');
    if (byKey.has(field.key)) return invalid(`duplicate_form_field:${field.key}`);
    byKey.set(field.key, field);
  }
  const scalarType = field => ['number', 'integer'].includes(field.type) ? 'number'
    : field.type === 'boolean' ? 'boolean' : field.type === 'multi_select' ? null : 'string';
  for (const field of fields) {
    if (!own(field, 'activeWhen')) continue;
    const condition = field.activeWhen, source = byKey.get(condition.field);
    if (!source) return invalid(`unknown_condition_field:${field.key}`);
    if (!own(condition, 'present')) {
      const type = scalarType(source), constants = own(condition, 'in') ? condition.in : [condition.eq];
      if (!type || constants.some(value => value === null || typeof value !== type
        || (type === 'number' && !Number.isFinite(value)))) return invalid(`condition_type:${field.key}`);
    }
  }
  const visiting = new Set(), ordered = [], visited = new Set();
  function visit(field) {
    if (visiting.has(field.key)) return false;
    if (visited.has(field.key)) return true;
    visiting.add(field.key);
    if (field.activeWhen && !visit(byKey.get(field.activeWhen.field))) return false;
    visiting.delete(field.key); visited.add(field.key); ordered.push(field);
    return true;
  }
  for (const field of fields) if (!visit(field)) return invalid('form_condition_cycle');
  const active = new Set();
  for (const field of ordered) {
    const condition = field.activeWhen;
    if (!condition) { active.add(field.key); continue; }
    if (!active.has(condition.field) || !own(values, condition.field)) continue;
    const value = values[condition.field];
    const hasValue = historical ? value != null && value !== '' && (!Array.isArray(value) || value.length > 0) : present(value);
    if (own(condition, 'present') ? hasValue
      : own(condition, 'eq') ? value === condition.eq : condition.in.includes(value)) active.add(field.key);
  }
  return { activeKeys: fields.filter(field => active.has(field.key)).map(field => field.key), errors: [] };
}

/**
 * Diagnose v2 form values only; action, context and free-text checks belong to
 * validateAnswer. With valid definitions, errors are ordered by submitted
 * inactive/unknown keys first, then active fields in their definition order.
 * Invalid definitions or a non-object values input return formError instead.
 */
export function validateFormFields(fields, values, options = {}) {
  const state = evaluateFormState(fields, values, options);
  if (state.errors.length) return { activeKeys: state.activeKeys, errors: [], formError: state.errors[0] };
  const active = new Set(state.activeKeys), known = new Set(fields.map(field => field.key)), errors = [];
  for (const key of Object.keys(values)) {
    if (!known.has(key)) errors.push({ key, reason: 'unknown' });
    else if (!active.has(key)) errors.push({ key, reason: 'inactive' });
  }
  for (const field of fields) {
    if (!active.has(field.key)) continue;
    const value = own(values, field.key) ? values[field.key] : undefined;
    if (validFieldValue(field, value, options)) continue;
    let reason = 'type';
    if (value == null || (field.required && !present(value))) reason = 'required';
    else if (['text', 'multiline_text'].includes(field.type) && typeof value === 'string') reason = 'range';
    else if (['number', 'integer'].includes(field.type) && typeValid(field.type, value)) reason = 'range';
    else if (field.type === 'single_select' && typeof value === 'string') reason = 'range';
    else if (field.type === 'multi_select' && Array.isArray(value) && value.every(item => typeof item === 'string')) reason = 'range';
    errors.push({ key: field.key, reason });
  }
  return { activeKeys: state.activeKeys, errors };
}

export function validateAnswer(action, questionEnvelope, { historical = false } = {}) {
  try {
    questionEnvelope = splitMessageView(questionEnvelope).envelope;
    if (!validAction(action) || !validEnvelope(questionEnvelope, !historical) || questionEnvelope.kind !== 'message' || !questionEnvelope.interrupt) return false;
    const block = questionEnvelope.blocks.find(item => item.id === questionEnvelope.interrupt.blockId), data = block.data;
    if (action.context.messageId !== questionEnvelope.messageId || action.context.blockId !== block.id
      || action.type !== data.action.type || action.target !== data.action.target || (data.state?.status ?? 'open') !== 'open') return false;
    const payload = action.payload;
    if (own(payload, 'freeText')) return questionEnvelope.interrupt.otherInput !== false
      && (historical || block.type !== 'choice' || data.allowFreeText !== false);
    if (block.type === 'choice') {
      const selected = payload.selected;
      return ((data.selection ?? 'single') !== 'single' || selected.length === 1)
        && selected.length >= (data.minSelect ?? 1) && selected.length <= (data.maxSelect ?? data.options.length)
        && selected.every(value => data.options.some(option => option.id === value));
    }
    if (block.type === 'confirmation') return ['confirm', 'cancel'].includes(payload.outcome);
    if (block.type === 'form_intent') {
      if (block.schemaVersion === 2) {
        const result = validateFormFields(data.fields, payload.values, { historical });
        return !result.formError && result.errors.length === 0;
      }
      return Object.keys(payload.values).every(key => data.fields.some(field => field.key === key))
        && data.fields.every(field => validFieldValue(field, own(payload.values, field.key) ? payload.values[field.key] : undefined, { historical }));
    }
    return false;
  } catch { return false; }
}
export function validateHookInput(value) {
  if (!keys(value, ['version', 'hook_event_name', 'hook_id', 'request_id', 'invocation_id', 'request', 'context'])
    || value.version !== 1 || value.hook_event_name !== 'BeforeSend'
    || !['hook_id', 'request_id', 'invocation_id'].every(key => string(value[key], 1))) return false;
  if (!keys(value.request, ['channel', 'endpoint', 'content', 'options']) || !string(value.request.channel, 1)
    || !(value.request.endpoint === null || typeof value.request.endpoint === 'string')
    || typeof value.request.content !== 'string' || !keys(value.request.options, [], ['groupName', 'wholeGroup'])
    || (own(value.request.options, 'groupName') && typeof value.request.options.groupName !== 'string')
    || (own(value.request.options, 'wholeGroup') && typeof value.request.options.wholeGroup !== 'boolean')) return false;
  return keys(value.context, [], ['component', 'session_group', 'runtime', 'session_id', 'run_id'])
    && Object.values(value.context).every(item => string(item, 1));
}
export function validateHookOutput(value) {
  if (!object(value) || value.version !== 1) return false;
  if (value.decision === 'continue') return keys(value, ['version', 'decision']);
  return value.decision === 'abort' && keys(value, ['version', 'decision', 'message']) && typeof value.message === 'string';
}
function sqliteId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) return null;
  return value.length < 19 || value <= '9223372036854775807' ? value : null;
}
export function validateDeliveryPacket(packet, row) {
  return keys(packet, ['version', 'c4_id', 'channel', 'endpoint_id', 'session_group', 'content']) && packet.version === 1
    && object(row) && sqliteId(packet.c4_id) !== null && sqliteId(packet.c4_id) === sqliteId(row.id)
    && string(packet.channel, 1) && (packet.endpoint_id === null || typeof packet.endpoint_id === 'string')
    && typeof packet.session_group === 'string' && typeof packet.content === 'string'
    && ['channel', 'endpoint_id', 'session_group', 'content'].every(key => packet[key] === row[key]);
}

// BEGIN GENERATED COMPONENT CATALOG
// Generated by scripts/generate-component-catalog.js; edit c4-component-catalog.js.
export const BLOCK_SCHEMA = {"type":"object","required":["id","type","schemaVersion"],"additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/blockId"},"type":{"enum":["markdown","time_series","breakdown","category_series","choice","confirmation","form_intent","diagram","x-zylos.image","x-zylos.file"]},"schemaVersion":{"enum":[1,2]},"data":{"type":"object"},"fallbackText":{"type":"string","maxLength":2000},"metadata":{"$ref":"#/$defs/blockMetadata"},"status":{"type":"string","enum":["complete","pending","error"]},"reason":{"type":"string","maxLength":500}},"allOf":[{"if":{"properties":{"type":{"not":{"const":"markdown"}}}},"then":{"required":["fallbackText"]}},{"if":{"properties":{"type":{"const":"markdown"}}},"then":{"properties":{"data":{"$ref":"#/$defs/markdownData"}}}},{"if":{"properties":{"type":{"const":"time_series"}}},"then":{"properties":{"data":{"$ref":"#/$defs/timeSeriesData"}}}},{"if":{"properties":{"type":{"const":"breakdown"}}},"then":{"properties":{"data":{"$ref":"#/$defs/breakdownData"}}}},{"if":{"properties":{"type":{"const":"category_series"}}},"then":{"properties":{"data":{"$ref":"#/$defs/categorySeriesData"}}}},{"if":{"properties":{"type":{"const":"choice"}}},"then":{"properties":{"data":{"$ref":"#/$defs/choiceData"}}}},{"if":{"properties":{"type":{"const":"confirmation"}}},"then":{"properties":{"data":{"$ref":"#/$defs/confirmationData"}}}},{"if":{"properties":{"type":{"const":"form_intent"},"schemaVersion":{"const":1}}},"then":{"properties":{"data":{"$ref":"#/$defs/formIntentData"}}}},{"if":{"properties":{"status":{"enum":["pending","error"]}},"required":["status"]},"then":{"required":["fallbackText"]},"else":{"required":["data"]}},{"if":{"properties":{"status":{"const":"error"}},"required":["status"]},"else":{"not":{"required":["reason"]}}},{"if":{"properties":{"metadata":{"properties":{"provenance":{"const":"adapter"}},"required":["provenance"]}},"required":["metadata"]},"then":{"properties":{"type":{"const":"markdown"}}}},{"if":{"properties":{"type":{"const":"diagram"}}},"then":{"properties":{"data":{"$ref":"#/$defs/diagramData"}}}},{"if":{"properties":{"schemaVersion":{"const":2}}},"then":{"properties":{"type":{"const":"form_intent"},"data":{"$ref":"#/$defs/formIntentDataV2"}}}},{"if":{"properties":{"type":{"const":"x-zylos.image"}}},"then":{"required":["data"],"properties":{"schemaVersion":{"const":1},"status":{"const":"complete"},"data":{"$ref":"#/$defs/attachmentData"}}}},{"if":{"properties":{"type":{"const":"x-zylos.file"}}},"then":{"required":["data"],"properties":{"schemaVersion":{"const":1},"status":{"const":"complete"},"data":{"$ref":"#/$defs/attachmentData"}}}}],"$defs":{"blockId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"key":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"label":{"type":"string","minLength":1,"maxLength":120},"shortLabel":{"type":"string","minLength":1,"maxLength":24},"text":{"type":"string","maxLength":2000},"unit":{"type":"string","minLength":1,"maxLength":32},"scalar":{"type":["number","string","boolean","null"],"maxLength":500},"temporal":{"type":"string","anyOf":[{"format":"date"},{"format":"date-time"}]},"assessment":{"type":"object","required":["status"],"additionalProperties":false,"properties":{"status":{"type":"string","enum":["positive","negative","warning","critical","neutral","info"]},"label":{"$ref":"#/$defs/label"},"detail":{"$ref":"#/$defs/text"}}},"valueFormat":{"type":"object","additionalProperties":false,"properties":{"style":{"type":"string","enum":["decimal","integer","percent","currency","duration"]},"currency":{"type":"string","pattern":"^[A-Z]{3}$"},"minorUnits":{"type":"boolean"},"maximumFractionDigits":{"type":"integer","minimum":0,"maximum":6}}},"blockMetadata":{"type":"object","additionalProperties":false,"properties":{"provenance":{"type":"string","enum":["model","tool","host","adapter"]},"asOf":{"type":"string","format":"date-time"},"citations":{"type":"array","maxItems":10,"items":{"type":"object","required":["label"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"url":{"type":"string","format":"uri","maxLength":2000},"ref":{"type":"string","maxLength":128}}}},"host":{"type":"object","maxProperties":16}}},"blockState":{"type":"object","required":["status"],"additionalProperties":false,"properties":{"status":{"type":"string","enum":["open","resolved","expired","cancelled","superseded"]},"selected":{"type":"array","maxItems":10,"items":{"$ref":"action.schema.json#/$defs/optionId"},"minItems":1,"uniqueItems":true},"freeText":{"type":"string","maxLength":500,"minLength":1},"outcome":{"type":"string","enum":["confirm","cancel"]},"values":{"type":"object","maxProperties":12},"resolvedBy":{"type":"string","minLength":1,"maxLength":128},"resolvedAt":{"type":"string","format":"date-time"},"supersededBy":{"type":"string","maxLength":200},"reason":{"type":"object","required":["code"],"additionalProperties":false,"properties":{"code":{"type":"string","enum":["withdrawn","policy","record_changed","record_deleted","permission_changed","stopped","other"]},"text":{"type":"string","maxLength":200}}},"note":{"$ref":"#/$defs/text"}},"allOf":[{"if":{"properties":{"status":{"const":"resolved"}},"required":["status"]},"then":{"required":["resolvedAt"]}},{"if":{"properties":{"status":{"const":"cancelled"}},"required":["status"]},"then":{"required":["reason"]}},{"if":{"properties":{"status":{"enum":["cancelled","expired","superseded"]}},"required":["status"]},"then":{"not":{"required":["resolvedBy"]}}},{"if":{"properties":{"status":{"enum":["open","resolved"]}},"required":["status"]},"then":{"not":{"required":["reason"]}}},{"if":{"properties":{"status":{"const":"resolved"}},"required":["status"]},"then":{"oneOf":[{"required":["selected"],"not":{"anyOf":[{"required":["outcome"]},{"required":["values"]},{"required":["freeText"]}]}},{"required":["outcome"],"not":{"anyOf":[{"required":["selected"]},{"required":["values"]},{"required":["freeText"]}]}},{"required":["values"],"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]},{"required":["freeText"]}]}},{"required":["freeText"],"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]},{"required":["values"]}]}}]},"else":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]},{"required":["values"]},{"required":["freeText"]},{"required":["resolvedAt"]},{"required":["resolvedBy"]}]}}},{"if":{"properties":{"status":{"const":"superseded"}},"required":["status"]},"then":{"required":["supersededBy"]},"else":{"not":{"required":["supersededBy"]}}}]},"markdownData":{"type":"object","required":["text"],"additionalProperties":false,"properties":{"text":{"type":"string","maxLength":32768}}},"timeSeriesData":{"type":"object","required":["xType","series"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"xType":{"type":"string","enum":["date","datetime","number","category"]},"xLabel":{"$ref":"#/$defs/label"},"yLabel":{"$ref":"#/$defs/label"},"yUnit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"series":{"type":"array","minItems":1,"maxItems":6,"items":{"type":"object","required":["key","label","points"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"points":{"type":"array","maxItems":500,"items":{"type":"object","required":["x","y"],"additionalProperties":false,"properties":{"x":{"type":["string","number"],"maxLength":64},"y":{"type":["number","null"]}}}}}}},"summary":{"$ref":"#/$defs/text"}}},"breakdownData":{"type":"object","required":["parts"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"parts":{"type":"array","minItems":2,"maxItems":12,"items":{"type":"object","required":["key","label","value"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"value":{"type":"number","minimum":0},"mergedCount":{"type":"integer","minimum":2}}}},"asOf":{"$ref":"#/$defs/temporal"},"summary":{"$ref":"#/$defs/text"}}},"categorySeriesData":{"type":"object","required":["points"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"xLabel":{"$ref":"#/$defs/label"},"yLabel":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"points":{"type":"array","minItems":1,"maxItems":24,"items":{"type":"object","required":["key","label","value"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"value":{"type":["number","null"]},"assessment":{"$ref":"#/$defs/assessment"}}}},"reference":{"type":"object","required":["label","value"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"value":{"type":"number"}}},"summary":{"$ref":"#/$defs/text"}}},"option":{"type":"object","required":["id","label"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"label":{"$ref":"#/$defs/label"},"description":{"$ref":"#/$defs/text"}}},"choiceData":{"type":"object","required":["prompt","options","action"],"additionalProperties":false,"properties":{"prompt":{"$ref":"#/$defs/text"},"options":{"type":"array","minItems":2,"maxItems":10,"items":{"$ref":"#/$defs/option"}},"selection":{"type":"string","enum":["single","multiple"]},"minSelect":{"type":"integer","minimum":0,"maximum":10},"maxSelect":{"type":"integer","minimum":1,"maximum":10},"allowFreeText":{"type":"boolean"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"choice.select"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["outcome"]},{"required":["values"]}]}}}}]},"confirmationData":{"type":"object","required":["title","severity","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"body":{"$ref":"#/$defs/text"},"severity":{"type":"string","enum":["normal","destructive"]},"details":{"type":"array","maxItems":12,"items":{"type":"object","required":["label","value"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"value":{"$ref":"#/$defs/scalar"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"}}}},"confirmLabel":{"$ref":"#/$defs/shortLabel"},"cancelLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"confirmation.respond"}}}]},"state":{"$ref":"#/$defs/blockState"}},"if":{"properties":{"action":{"properties":{"requiresConfirmation":{"const":true}},"required":["requiresConfirmation"]}}},"then":{"properties":{"severity":{"const":"destructive"}}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["values"]}]}}}}]},"formField":{"type":"object","required":["key","label","type"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"type":{"type":"string","enum":["text","multiline_text","number","integer","date","datetime","boolean","single_select","multi_select"]},"required":{"type":"boolean"},"options":{"type":"array","maxItems":20,"items":{"$ref":"#/$defs/option"}},"min":{"type":"number"},"max":{"type":"number"},"maxLength":{"type":"integer","minimum":1,"maximum":2000},"unit":{"$ref":"#/$defs/unit"},"placeholder":{"$ref":"#/$defs/label"},"help":{"$ref":"#/$defs/text"},"defaultValue":{"anyOf":[{"$ref":"#/$defs/scalar"},{"type":"array","maxItems":20,"items":{"type":"string","maxLength":64}}]}},"allOf":[{"if":{"properties":{"type":{"enum":["single_select","multi_select"]}}},"then":{"required":["options"],"properties":{"options":{"minItems":1}}}}]},"formIntentData":{"type":"object","required":["fields","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"purpose":{"$ref":"#/$defs/text"},"fields":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/formField"}},"submitLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"form.submit"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]}]}}}}]},"diagramNode":{"type":"object","required":["label"],"additionalProperties":false,"properties":{"label":{"type":"string","minLength":1,"maxLength":40},"detail":{"type":"string","maxLength":120},"icon":{"type":"string","pattern":"^[a-z][a-z0-9-]{0,31}$"},"highlight":{"type":"boolean"}}},"diagramLink":{"description":"Connects this step to the next step, never individual nodes.","type":"object","additionalProperties":false,"properties":{"arrow":{"type":"string","enum":["forward","both","none"],"default":"forward"},"label":{"type":"string","maxLength":40}}},"diagramStep":{"type":"object","required":["nodes"],"additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/blockId"},"nodes":{"type":"array","minItems":1,"maxItems":3,"items":{"$ref":"#/$defs/diagramNode"}},"link":{"$ref":"#/$defs/diagramLink"}}},"diagramGroup":{"description":"Inclusive range of step ids in wire order. A group may contain one step; groups must not share any step.","type":"object","required":["label","from","to"],"additionalProperties":false,"properties":{"label":{"type":"string","minLength":1,"maxLength":24},"from":{"$ref":"#/$defs/blockId"},"to":{"$ref":"#/$defs/blockId"}}},"diagramData":{"description":"Ordered steps of one to three parallel nodes, with optional links to the next step. Omitted direction means vertical; omitted links mean unlabelled forward arrows. Horizontal diagrams with more than five steps render vertically. No arbitrary edges are supported.","type":"object","required":["steps"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"direction":{"type":"string","enum":["vertical","horizontal"],"default":"vertical"},"steps":{"type":"array","minItems":2,"maxItems":8,"items":{"$ref":"#/$defs/diagramStep"}},"groups":{"type":"array","maxItems":3,"items":{"$ref":"#/$defs/diagramGroup"}},"summary":{"$ref":"#/$defs/text"}}},"activeWhen":{"oneOf":[{"type":"object","required":["field","eq"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"eq":{"type":["string","number","boolean"]}}},{"type":"object","required":["field","in"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"in":{"type":"array","minItems":1,"maxItems":20,"items":{"type":["string","number","boolean"]}}}},{"type":"object","required":["field","present"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"present":{"const":true}}}]},"formFieldV2":{"type":"object","required":["key","label","type"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"type":{"type":"string","enum":["text","multiline_text","number","integer","date","datetime","boolean","single_select","multi_select"]},"required":{"type":"boolean"},"options":{"type":"array","maxItems":20,"items":{"$ref":"#/$defs/option"}},"min":{"type":"number"},"max":{"type":"number"},"maxLength":{"type":"integer","minimum":1,"maximum":2000},"unit":{"$ref":"#/$defs/unit"},"placeholder":{"$ref":"#/$defs/label"},"help":{"$ref":"#/$defs/text"},"defaultValue":{"anyOf":[{"$ref":"#/$defs/scalar"},{"type":"array","maxItems":20,"items":{"type":"string","maxLength":64}}]},"activeWhen":{"$ref":"#/$defs/activeWhen"}},"allOf":[{"if":{"properties":{"type":{"enum":["single_select","multi_select"]}}},"then":{"required":["options"],"properties":{"options":{"minItems":1}}}}]},"formIntentDataV2":{"type":"object","required":["fields","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"purpose":{"$ref":"#/$defs/text"},"fields":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/formFieldV2"}},"submitLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"form.submit"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]}]}}}}]},"attachmentData":{"type":"object","required":["attachmentId","nameSnapshot"],"additionalProperties":false,"properties":{"attachmentId":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,128}$"},"nameSnapshot":{"type":"string","minLength":1,"maxLength":160}}}}};
export const ACTION_SCHEMA = {"$defs":{"messageId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"},"blockId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"optionId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"actionId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$"},"actionType":{"type":"string","enum":["choice.select","confirmation.respond","form.submit"]},"target":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){0,3}$","maxLength":64},"actionSpec":{"type":"object","required":["type","target"],"additionalProperties":false,"properties":{"type":{"$ref":"#/$defs/actionType"},"target":{"$ref":"#/$defs/target"},"requiresConfirmation":{"type":"boolean"},"expiresAt":{"type":"string","format":"date-time"}},"if":{"properties":{"requiresConfirmation":{"const":true}},"required":["requiresConfirmation"]},"then":{"properties":{"type":{"const":"confirmation.respond"}}}},"actionContext":{"type":"object","required":["messageId","blockId"],"additionalProperties":false,"properties":{"conversationId":{"$ref":"#/$defs/messageId"},"messageId":{"$ref":"#/$defs/messageId"},"blockId":{"$ref":"#/$defs/blockId"}}},"choiceSelectPayload":{"type":"object","additionalProperties":false,"properties":{"selected":{"type":"array","items":{"$ref":"#/$defs/optionId"},"minItems":1,"maxItems":10,"uniqueItems":true},"freeText":{"$ref":"#/$defs/freeText"}},"oneOf":[{"required":["selected"]},{"required":["freeText"]}]},"freeText":{"type":"string","minLength":1,"maxLength":500},"confirmationRespondPayload":{"type":"object","additionalProperties":false,"properties":{"outcome":{"type":"string","enum":["confirm","cancel"]},"freeText":{"$ref":"#/$defs/freeText"}},"oneOf":[{"required":["outcome"]},{"required":["freeText"]}]},"formSubmitPayload":{"type":"object","additionalProperties":false,"oneOf":[{"required":["values"]},{"required":["freeText"]}],"properties":{"freeText":{"$ref":"#/$defs/freeText"},"values":{"type":"object","maxProperties":12,"propertyNames":{"pattern":"^[a-z][a-z0-9_]{0,31}$"},"additionalProperties":{"anyOf":[{"type":["string","number","boolean","null"],"maxLength":2000},{"type":"array","maxItems":20,"items":{"type":"string","maxLength":64}}]}}}},"actionRequest":{"type":"object","required":["id","protocolVersion","type","target","context","payload"],"additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/actionId"},"protocolVersion":{"type":"string","pattern":"^[0-9]+\\.[0-9]+$"},"type":{"$ref":"#/$defs/actionType"},"target":{"$ref":"#/$defs/target"},"context":{"$ref":"#/$defs/actionContext"},"payload":{"type":"object"},"clientTs":{"type":"string","format":"date-time"}},"allOf":[{"if":{"properties":{"type":{"const":"choice.select"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/choiceSelectPayload"}}}},{"if":{"properties":{"type":{"const":"confirmation.respond"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/confirmationRespondPayload"}}}},{"if":{"properties":{"type":{"const":"form.submit"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/formSubmitPayload"}}}}]}}};
export const CATALOG_SOURCE = {"coreCommit":"977958c913d19be5ebe80fa03a5133f61b4acbb9","chatweaveCommit":"5c4288338e2a6a50c236d06e51e346c080ae7141"};
export const HOST_SCHEMA_SOURCE = {"designCommit":"74b653a","viewSchemaVersion":1,"formSchemaVersion":2};
export const VIEW_SCHEMA = {"type":"object","required":["schemaVersion","root","nodes"],"additionalProperties":false,"properties":{"schemaVersion":{"const":1},"root":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"nodes":{"type":"array","minItems":1,"maxItems":128,"items":{"$ref":"#/$defs/node"}}},"$defs":{"node":{"oneOf":[{"type":"object","required":["id","type","children"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"type":{"const":"stack"},"children":{"type":"array","maxItems":128,"items":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"minItems":1},"gap":{"enum":["compact","normal"]}}},{"type":"object","required":["id","type","children"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"type":{"const":"columns"},"children":{"type":"array","maxItems":4,"items":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"minItems":2},"layout":{"enum":["balanced","sidebar"]}},"if":{"properties":{"layout":{"const":"sidebar"}},"required":["layout"]},"then":{"properties":{"children":{"minItems":2,"maxItems":2}}}},{"type":"object","required":["id","type"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"type":{"const":"section"},"header":{"type":"array","maxItems":128,"items":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"}},"body":{"type":"array","maxItems":128,"items":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"}},"actions":{"type":"array","maxItems":128,"items":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"}}},"anyOf":[{"required":["header"],"properties":{"header":{"minItems":1}}},{"required":["body"],"properties":{"body":{"minItems":1}}},{"required":["actions"],"properties":{"actions":{"minItems":1}}}]},{"type":"object","required":["id","type","blockId"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"type":{"const":"block"},"blockId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"}}}]}}};
export const FORM_CONDITION_SCHEMA = {"oneOf":[{"type":"object","required":["field","eq"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"eq":{"type":["string","number","boolean"]}}},{"type":"object","required":["field","in"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"in":{"type":"array","minItems":1,"maxItems":20,"items":{"type":["string","number","boolean"]}}}},{"type":"object","required":["field","present"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"present":{"const":true}}}]};
export const COMPONENT_DEFINITIONS = [{"key":"markdown@1","type":"markdown","schemaVersion":1,"interactive":false,"description":"Text content. Use data.text for Markdown; keep the envelope fallback readable without a renderer.","useWhen":"Use plain Markdown for ordinary explanations, short answers, steps and code. Keep tables as Markdown tables; use a chart only when it improves understanding.","parameters":{"type":"object","required":["text"],"additionalProperties":false,"properties":{"text":{"type":"string","maxLength":32768}}},"example":{"version":1,"kind":"message","messageId":"markdown_message","fallbackText":"部署已完成：3 个服务都在运行，没有报错。","blocks":[{"id":"text","type":"markdown","schemaVersion":1,"data":{"text":"部署已完成：**3 个服务**都在运行，没有报错。"}}]}},{"key":"time_series@1","type":"time_series","schemaVersion":1,"interactive":false,"description":"A bounded series chart with xType and one to six labeled series; each series has at most 500 x/y points. For xType date, write each x as YYYY-MM-DD (recommended); epoch milliseconds and date-times with Z or an offset are shown on their calendar day in the agent instance time zone (TZ in .env).","useWhen":"Use for time trends when at least two dated or ordered measurements are available, such as daily usage. Include one or two sentences explaining the takeaway; do not send only a chart or invent missing data.","parameters":{"type":"object","required":["xType","series"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"xType":{"type":"string","enum":["date","datetime","number","category"]},"xLabel":{"$ref":"#/$defs/label"},"yLabel":{"$ref":"#/$defs/label"},"yUnit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"series":{"type":"array","minItems":1,"maxItems":6,"items":{"type":"object","required":["key","label","points"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"points":{"type":"array","maxItems":500,"items":{"type":"object","required":["x","y"],"additionalProperties":false,"properties":{"x":{"type":["string","number"],"maxLength":64},"y":{"type":["number","null"]}}}}}}},"summary":{"$ref":"#/$defs/text"}}},"example":{"version":1,"kind":"message","messageId":"chart_message","fallbackText":"近两天用量：11-01 为 1，11-02 暂无数据。","blocks":[{"id":"chart","type":"time_series","schemaVersion":1,"data":{"xType":"date","series":[{"key":"usage","label":"用量","points":[{"x":"2026-11-01","y":1},{"x":"2026-11-02","y":null}]}]},"fallbackText":"用量图：首日1，次日未知"}]}},{"key":"breakdown@1","type":"breakdown","schemaVersion":1,"interactive":false,"description":"A nonnegative breakdown with two to twelve keyed, labeled parts.","useWhen":"Use for part-to-whole shares when two to twelve nonnegative parts of a meaningful total are available, such as PR shares by status. Include one or two sentences explaining the takeaway; do not send only a chart or invent values.","parameters":{"type":"object","required":["parts"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"parts":{"type":"array","minItems":2,"maxItems":12,"items":{"type":"object","required":["key","label","value"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"value":{"type":"number","minimum":0},"mergedCount":{"type":"integer","minimum":2}}}},"asOf":{"$ref":"#/$defs/temporal"},"summary":{"$ref":"#/$defs/text"}}},"example":{"version":1,"kind":"message","messageId":"breakdown_message","fallbackText":"构成：甲 2（40%），乙 3（60%），共 5。","blocks":[{"id":"parts","type":"breakdown","schemaVersion":1,"data":{"parts":[{"key":"a","label":"甲","value":2},{"key":"b","label":"乙","value":3}]},"fallbackText":"甲2，乙3"}]}},{"key":"category_series@1","type":"category_series","schemaVersion":1,"interactive":false,"description":"One to twenty-four keyed, labeled category values, including signed numbers or null for unavailable values. yLabel names the numeric value axis, shown below horizontal bars; category labels identify each row.","useWhen":"Use to compare one to twenty-four categories with known values, such as PR counts by status. Include one or two sentences explaining the takeaway; do not send only a chart or invent values.","parameters":{"type":"object","required":["points"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"xLabel":{"$ref":"#/$defs/label"},"yLabel":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"points":{"type":"array","minItems":1,"maxItems":24,"items":{"type":"object","required":["key","label","value"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"value":{"type":["number","null"]},"assessment":{"$ref":"#/$defs/assessment"}}}},"reference":{"type":"object","required":["label","value"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"value":{"type":"number"}}},"summary":{"$ref":"#/$defs/text"}}},"example":{"version":1,"kind":"message","messageId":"category_message","fallbackText":"分类对比：甲为 0，乙暂无数据。","blocks":[{"id":"categories","type":"category_series","schemaVersion":1,"data":{"points":[{"key":"a","label":"甲","value":0},{"key":"b","label":"乙","value":null}]},"fallbackText":"甲0，乙未知"}]}},{"key":"choice@1","type":"choice","schemaVersion":1,"interactive":true,"description":"An explicit single- or multiple-choice question with two to ten options and a choice.select action. Selection constraints are validated against the saved question.","useWhen":"Use when the user needs to select among two to ten concrete options, including choosing between proposed plans. Ask one clear question and wait for the answer; use Markdown when no user selection is needed.","parameters":{"type":"object","required":["prompt","options","action"],"additionalProperties":false,"properties":{"prompt":{"$ref":"#/$defs/text"},"options":{"type":"array","minItems":2,"maxItems":10,"items":{"$ref":"#/$defs/option"}},"selection":{"type":"string","enum":["single","multiple"]},"minSelect":{"type":"integer","minimum":0,"maximum":10},"maxSelect":{"type":"integer","minimum":1,"maximum":10},"allowFreeText":{"type":"boolean"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"choice.select"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["outcome"]},{"required":["values"]}]}}}}]},"example":{"version":1,"kind":"message","messageId":"single_question","fallbackText":"选一个方案；等待用户回答。","blocks":[{"id":"question","type":"choice","schemaVersion":1,"data":{"prompt":"选一个方案","options":[{"id":"a","label":"方案甲"},{"id":"b","label":"方案乙"}],"action":{"type":"choice.select","target":"clarification.answer"}},"fallbackText":"选一个方案"}],"interruptId":"interrupt_single_question","questionSummary":"选一个方案","interrupt":{"blockId":"question","reason":"input_required"}}},{"key":"confirmation@1","type":"confirmation","schemaVersion":1,"interactive":true,"description":"An explicit confirm/cancel question with a confirmation.respond action. An action marked requiresConfirmation must use destructive severity.","useWhen":"Use to request explicit confirmation before a dangerous or irreversible operation, such as deleting a group. State the operation and its consequences, then wait for the user to answer before acting.","parameters":{"type":"object","required":["title","severity","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"body":{"$ref":"#/$defs/text"},"severity":{"type":"string","enum":["normal","destructive"]},"details":{"type":"array","maxItems":12,"items":{"type":"object","required":["label","value"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"value":{"$ref":"#/$defs/scalar"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"}}}},"confirmLabel":{"$ref":"#/$defs/shortLabel"},"cancelLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"confirmation.respond"}}}]},"state":{"$ref":"#/$defs/blockState"}},"if":{"properties":{"action":{"properties":{"requiresConfirmation":{"const":true}},"required":["requiresConfirmation"]}}},"then":{"properties":{"severity":{"const":"destructive"}}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["values"]}]}}}}]},"example":{"version":1,"kind":"message","messageId":"confirmation_question","fallbackText":"确认执行？；等待用户回答。","blocks":[{"id":"question","type":"confirmation","schemaVersion":1,"data":{"title":"确认执行？","severity":"destructive","action":{"type":"confirmation.respond","target":"operation.confirm","requiresConfirmation":true}},"fallbackText":"确认执行？"}],"interruptId":"interrupt_confirmation_question","questionSummary":"确认执行？","interrupt":{"blockId":"question","reason":"confirmation"}}},{"key":"form_intent@1","type":"form_intent","schemaVersion":1,"interactive":true,"description":"A version-one form with one to twelve fields and a form.submit action. Fields may use text, multiline_text, number, integer, date, datetime, boolean, single_select or multi_select.","useWhen":"Use when the user needs to provide multiple related fields together. Ask only for needed information; use a short Markdown question for a single simple detail.","parameters":{"type":"object","required":["fields","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"purpose":{"$ref":"#/$defs/text"},"fields":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/formField"}},"submitLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"form.submit"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]}]}}}}]},"example":{"version":1,"kind":"message","messageId":"form_question","fallbackText":"登记信息；等待用户回答。","blocks":[{"id":"question","type":"form_intent","schemaVersion":1,"data":{"title":"登记信息","fields":[{"key":"name","label":"名字","type":"text","required":true,"maxLength":20},{"key":"count","label":"数量","type":"integer","min":1,"max":5},{"key":"tags","label":"标签","type":"multi_select","options":[{"id":"a","label":"甲"},{"id":"b","label":"乙"}]}],"action":{"type":"form.submit","target":"information.submit"}},"fallbackText":"登记信息"}],"interruptId":"interrupt_form_question","questionSummary":"登记信息","interrupt":{"blockId":"question","reason":"input_required"}}},{"key":"diagram@1","type":"diagram","schemaVersion":1,"interactive":false,"description":"Ordered steps with optional links and up to three disjoint inclusive groups {label,from,to}. Optional step IDs must be unique; group endpoints name existing steps in wire order, including single-step groups. Direction defaults to vertical; horizontal flows over five steps render vertically. Links default to unlabelled forward arrows; the last link is ignored. Node icons use ^[a-z][a-z0-9-]{0,31}$; known icons: bot, monitor, server, network, code, terminal, layers, component, tool, settings, book, chart, message, key, lock, clock, alert, check, search, target, user, users, smartphone, glasses, database, cloud, globe, file. Unknown valid icon names are accepted with the icon omitted.","useWhen":"Use for a bounded workflow or architecture with two to eight ordered steps and one to three parallel nodes per step. Include a readable fallback explaining the flow.","parameters":{"description":"Ordered steps of one to three parallel nodes, with optional links to the next step. Omitted direction means vertical; omitted links mean unlabelled forward arrows. Horizontal diagrams with more than five steps render vertically. No arbitrary edges are supported.","type":"object","required":["steps"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"direction":{"type":"string","enum":["vertical","horizontal"],"default":"vertical"},"steps":{"type":"array","minItems":2,"maxItems":8,"items":{"$ref":"#/$defs/diagramStep"}},"groups":{"type":"array","maxItems":3,"items":{"$ref":"#/$defs/diagramGroup"}},"summary":{"$ref":"#/$defs/text"}}},"example":{"version":1,"kind":"message","messageId":"diagram_message","fallbackText":"Client sends a request to the server.","blocks":[{"id":"flow","type":"diagram","schemaVersion":1,"fallbackText":"Client -> Server","data":{"steps":[{"id":"client","nodes":[{"label":"Client","icon":"monitor"}]},{"id":"server","nodes":[{"label":"Server","icon":"server"}]}]}}]}},{"key":"form_intent@2","type":"form_intent","schemaVersion":2,"interactive":true,"description":"A conditional form. Field activeWhen uses scalar eq/in or present:true; hidden upstream values are missing downstream. Submit only active keys.","useWhen":"Use when the user needs to provide multiple related fields and later questions depend on earlier answers. Ask only for needed information; use a short Markdown question for a single simple detail.","parameters":{"type":"object","required":["fields","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"purpose":{"$ref":"#/$defs/text"},"fields":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/formFieldV2"}},"submitLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"form.submit"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]}]}}}}]},"example":{"version":1,"kind":"message","messageId":"conditional_form_question","fallbackText":"登记主体信息；等待用户回答。","blocks":[{"id":"question","type":"form_intent","schemaVersion":2,"data":{"title":"登记主体信息","fields":[{"key":"customer_type","label":"主体类型","type":"single_select","required":true,"options":[{"id":"person","label":"个人"},{"id":"company","label":"企业"}]},{"key":"company_name","label":"公司名称","type":"text","required":true,"activeWhen":{"field":"customer_type","eq":"company"}}],"action":{"type":"form.submit","target":"information.submit"}},"fallbackText":"登记主体信息"}],"interruptId":"interrupt_conditional_form_question","questionSummary":"登记主体信息","interrupt":{"blockId":"question","reason":"input_required"}}}];
export const INTERACTIVE_COMPONENT_TYPES = ["choice","confirmation","form_intent"];
export const REGISTERED_COMPONENT_KEYS = ["markdown@1","time_series@1","breakdown@1","category_series@1","choice@1","confirmation@1","form_intent@1","diagram@1","form_intent@2"];
export const MODEL_INSTRUCTIONS = "C4 version 1; ChatWeave protocol 0.1. Use only the components listed below.\n\nSend the complete example envelope with the exact [C4-JSON] marker followed by a newline.\n\nReplace example values while preserving field constraints. Every non-markdown block needs fallbackText. Write fallbackText as the real message in plain words, not a placeholder: it is what channels without a renderer show.\n\nA stored C4 message is never updated in place: a block with status pending stays pending, so send a complete block in a later message instead. Omit action.expiresAt: the host neither displays nor enforces it, and a late answer to an open question is still accepted.\n\nInteractive messages need the matching interrupt and summary. questionSummary must equal makeQuestionSummary(envelope): use the interrupted block's first nonempty string from fallbackText, data.prompt, data.title, data.purpose, then the envelope fallbackText; collapse whitespace to single spaces, trim, and keep the first 500 Unicode characters. Actions are checked against the stored question.\n\nParameter references resolve against BLOCK_SCHEMA.$defs or ACTION_SCHEMA.$defs in the same schema module.\n\nmarkdown@1: Text content. Use data.text for Markdown; keep the envelope fallback readable without a renderer.\nWhen to use: Use plain Markdown for ordinary explanations, short answers, steps and code. Keep tables as Markdown tables; use a chart only when it improves understanding.\nParameters: {\"type\":\"object\",\"required\":[\"text\"],\"additionalProperties\":false,\"properties\":{\"text\":{\"type\":\"string\",\"maxLength\":32768}}}\n\ntime_series@1: A bounded series chart with xType and one to six labeled series; each series has at most 500 x/y points. For xType date, write each x as YYYY-MM-DD (recommended); epoch milliseconds and date-times with Z or an offset are shown on their calendar day in the agent instance time zone (TZ in .env).\nWhen to use: Use for time trends when at least two dated or ordered measurements are available, such as daily usage. Include one or two sentences explaining the takeaway; do not send only a chart or invent missing data.\nParameters: {\"type\":\"object\",\"required\":[\"xType\",\"series\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"xType\":{\"type\":\"string\",\"enum\":[\"date\",\"datetime\",\"number\",\"category\"]},\"xLabel\":{\"$ref\":\"#/$defs/label\"},\"yLabel\":{\"$ref\":\"#/$defs/label\"},\"yUnit\":{\"$ref\":\"#/$defs/unit\"},\"format\":{\"$ref\":\"#/$defs/valueFormat\"},\"series\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":6,\"items\":{\"type\":\"object\",\"required\":[\"key\",\"label\",\"points\"],\"additionalProperties\":false,\"properties\":{\"key\":{\"$ref\":\"#/$defs/key\"},\"label\":{\"$ref\":\"#/$defs/label\"},\"unit\":{\"$ref\":\"#/$defs/unit\"},\"points\":{\"type\":\"array\",\"maxItems\":500,\"items\":{\"type\":\"object\",\"required\":[\"x\",\"y\"],\"additionalProperties\":false,\"properties\":{\"x\":{\"type\":[\"string\",\"number\"],\"maxLength\":64},\"y\":{\"type\":[\"number\",\"null\"]}}}}}}},\"summary\":{\"$ref\":\"#/$defs/text\"}}}\n\nbreakdown@1: A nonnegative breakdown with two to twelve keyed, labeled parts.\nWhen to use: Use for part-to-whole shares when two to twelve nonnegative parts of a meaningful total are available, such as PR shares by status. Include one or two sentences explaining the takeaway; do not send only a chart or invent values.\nParameters: {\"type\":\"object\",\"required\":[\"parts\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"unit\":{\"$ref\":\"#/$defs/unit\"},\"format\":{\"$ref\":\"#/$defs/valueFormat\"},\"parts\":{\"type\":\"array\",\"minItems\":2,\"maxItems\":12,\"items\":{\"type\":\"object\",\"required\":[\"key\",\"label\",\"value\"],\"additionalProperties\":false,\"properties\":{\"key\":{\"$ref\":\"#/$defs/key\"},\"label\":{\"$ref\":\"#/$defs/label\"},\"value\":{\"type\":\"number\",\"minimum\":0},\"mergedCount\":{\"type\":\"integer\",\"minimum\":2}}}},\"asOf\":{\"$ref\":\"#/$defs/temporal\"},\"summary\":{\"$ref\":\"#/$defs/text\"}}}\n\ncategory_series@1: One to twenty-four keyed, labeled category values, including signed numbers or null for unavailable values. yLabel names the numeric value axis, shown below horizontal bars; category labels identify each row.\nWhen to use: Use to compare one to twenty-four categories with known values, such as PR counts by status. Include one or two sentences explaining the takeaway; do not send only a chart or invent values.\nParameters: {\"type\":\"object\",\"required\":[\"points\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"xLabel\":{\"$ref\":\"#/$defs/label\"},\"yLabel\":{\"$ref\":\"#/$defs/label\"},\"unit\":{\"$ref\":\"#/$defs/unit\"},\"format\":{\"$ref\":\"#/$defs/valueFormat\"},\"points\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":24,\"items\":{\"type\":\"object\",\"required\":[\"key\",\"label\",\"value\"],\"additionalProperties\":false,\"properties\":{\"key\":{\"$ref\":\"#/$defs/key\"},\"label\":{\"$ref\":\"#/$defs/label\"},\"value\":{\"type\":[\"number\",\"null\"]},\"assessment\":{\"$ref\":\"#/$defs/assessment\"}}}},\"reference\":{\"type\":\"object\",\"required\":[\"label\",\"value\"],\"additionalProperties\":false,\"properties\":{\"label\":{\"$ref\":\"#/$defs/label\"},\"value\":{\"type\":\"number\"}}},\"summary\":{\"$ref\":\"#/$defs/text\"}}}\n\nchoice@1: An explicit single- or multiple-choice question with two to ten options and a choice.select action. Selection constraints are validated against the saved question.\nWhen to use: Use when the user needs to select among two to ten concrete options, including choosing between proposed plans. Ask one clear question and wait for the answer; use Markdown when no user selection is needed.\nParameters: {\"type\":\"object\",\"required\":[\"prompt\",\"options\",\"action\"],\"additionalProperties\":false,\"properties\":{\"prompt\":{\"$ref\":\"#/$defs/text\"},\"options\":{\"type\":\"array\",\"minItems\":2,\"maxItems\":10,\"items\":{\"$ref\":\"#/$defs/option\"}},\"selection\":{\"type\":\"string\",\"enum\":[\"single\",\"multiple\"]},\"minSelect\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":10},\"maxSelect\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":10},\"allowFreeText\":{\"type\":\"boolean\"},\"action\":{\"allOf\":[{\"$ref\":\"action.schema.json#/$defs/actionSpec\"},{\"properties\":{\"type\":{\"const\":\"choice.select\"}}}]},\"state\":{\"$ref\":\"#/$defs/blockState\"}},\"allOf\":[{\"properties\":{\"state\":{\"not\":{\"anyOf\":[{\"required\":[\"outcome\"]},{\"required\":[\"values\"]}]}}}}]}\n\nconfirmation@1: An explicit confirm/cancel question with a confirmation.respond action. An action marked requiresConfirmation must use destructive severity.\nWhen to use: Use to request explicit confirmation before a dangerous or irreversible operation, such as deleting a group. State the operation and its consequences, then wait for the user to answer before acting.\nParameters: {\"type\":\"object\",\"required\":[\"title\",\"severity\",\"action\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"body\":{\"$ref\":\"#/$defs/text\"},\"severity\":{\"type\":\"string\",\"enum\":[\"normal\",\"destructive\"]},\"details\":{\"type\":\"array\",\"maxItems\":12,\"items\":{\"type\":\"object\",\"required\":[\"label\",\"value\"],\"additionalProperties\":false,\"properties\":{\"label\":{\"$ref\":\"#/$defs/label\"},\"value\":{\"$ref\":\"#/$defs/scalar\"},\"unit\":{\"$ref\":\"#/$defs/unit\"},\"format\":{\"$ref\":\"#/$defs/valueFormat\"}}}},\"confirmLabel\":{\"$ref\":\"#/$defs/shortLabel\"},\"cancelLabel\":{\"$ref\":\"#/$defs/shortLabel\"},\"action\":{\"allOf\":[{\"$ref\":\"action.schema.json#/$defs/actionSpec\"},{\"properties\":{\"type\":{\"const\":\"confirmation.respond\"}}}]},\"state\":{\"$ref\":\"#/$defs/blockState\"}},\"if\":{\"properties\":{\"action\":{\"properties\":{\"requiresConfirmation\":{\"const\":true}},\"required\":[\"requiresConfirmation\"]}}},\"then\":{\"properties\":{\"severity\":{\"const\":\"destructive\"}}},\"allOf\":[{\"properties\":{\"state\":{\"not\":{\"anyOf\":[{\"required\":[\"selected\"]},{\"required\":[\"values\"]}]}}}}]}\n\nform_intent@1: A version-one form with one to twelve fields and a form.submit action. Fields may use text, multiline_text, number, integer, date, datetime, boolean, single_select or multi_select.\nWhen to use: Use when the user needs to provide multiple related fields together. Ask only for needed information; use a short Markdown question for a single simple detail.\nParameters: {\"type\":\"object\",\"required\":[\"fields\",\"action\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"purpose\":{\"$ref\":\"#/$defs/text\"},\"fields\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":12,\"items\":{\"$ref\":\"#/$defs/formField\"}},\"submitLabel\":{\"$ref\":\"#/$defs/shortLabel\"},\"action\":{\"allOf\":[{\"$ref\":\"action.schema.json#/$defs/actionSpec\"},{\"properties\":{\"type\":{\"const\":\"form.submit\"}}}]},\"state\":{\"$ref\":\"#/$defs/blockState\"}},\"allOf\":[{\"properties\":{\"state\":{\"not\":{\"anyOf\":[{\"required\":[\"selected\"]},{\"required\":[\"outcome\"]}]}}}}]}\n\ndiagram@1: Ordered steps with optional links and up to three disjoint inclusive groups {label,from,to}. Optional step IDs must be unique; group endpoints name existing steps in wire order, including single-step groups. Direction defaults to vertical; horizontal flows over five steps render vertically. Links default to unlabelled forward arrows; the last link is ignored. Node icons use ^[a-z][a-z0-9-]{0,31}$; known icons: bot, monitor, server, network, code, terminal, layers, component, tool, settings, book, chart, message, key, lock, clock, alert, check, search, target, user, users, smartphone, glasses, database, cloud, globe, file. Unknown valid icon names are accepted with the icon omitted.\nWhen to use: Use for a bounded workflow or architecture with two to eight ordered steps and one to three parallel nodes per step. Include a readable fallback explaining the flow.\nParameters: {\"description\":\"Ordered steps of one to three parallel nodes, with optional links to the next step. Omitted direction means vertical; omitted links mean unlabelled forward arrows. Horizontal diagrams with more than five steps render vertically. No arbitrary edges are supported.\",\"type\":\"object\",\"required\":[\"steps\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"direction\":{\"type\":\"string\",\"enum\":[\"vertical\",\"horizontal\"],\"default\":\"vertical\"},\"steps\":{\"type\":\"array\",\"minItems\":2,\"maxItems\":8,\"items\":{\"$ref\":\"#/$defs/diagramStep\"}},\"groups\":{\"type\":\"array\",\"maxItems\":3,\"items\":{\"$ref\":\"#/$defs/diagramGroup\"}},\"summary\":{\"$ref\":\"#/$defs/text\"}}}\n\nform_intent@2: A conditional form. Field activeWhen uses scalar eq/in or present:true; hidden upstream values are missing downstream. Submit only active keys.\nWhen to use: Use when the user needs to provide multiple related fields and later questions depend on earlier answers. Ask only for needed information; use a short Markdown question for a single simple detail.\nParameters: {\"type\":\"object\",\"required\":[\"fields\",\"action\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"purpose\":{\"$ref\":\"#/$defs/text\"},\"fields\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":12,\"items\":{\"$ref\":\"#/$defs/formFieldV2\"}},\"submitLabel\":{\"$ref\":\"#/$defs/shortLabel\"},\"action\":{\"allOf\":[{\"$ref\":\"action.schema.json#/$defs/actionSpec\"},{\"properties\":{\"type\":{\"const\":\"form.submit\"}}}]},\"state\":{\"$ref\":\"#/$defs/blockState\"}},\"allOf\":[{\"properties\":{\"state\":{\"not\":{\"anyOf\":[{\"required\":[\"selected\"]},{\"required\":[\"outcome\"]}]}}}}]}";
const blockTypes = BLOCK_SCHEMA.properties.type.enum;
const interactive = INTERACTIVE_COMPONENT_TYPES;
// END GENERATED COMPONENT CATALOG

// Read-only compatibility validates the shared block shape without applying
// a known type's data schema. The strict wire schema above remains unchanged.
const UNKNOWN_BLOCK_SCHEMA = {
  ...BLOCK_SCHEMA,
  required: [...BLOCK_SCHEMA.required, 'fallbackText'],
  properties: {
    ...BLOCK_SCHEMA.properties,
    type: { type: 'string', minLength: 1 },
    fallbackText: { ...BLOCK_SCHEMA.properties.fallbackText, minLength: 1 },
  },
  // These shared rules require data for complete blocks, fallback for unfinished
  // blocks, and restrict reason to error status. Other rules are type-specific.
  allOf: BLOCK_SCHEMA.allOf.filter(rule => rule.if?.properties?.status),
};
