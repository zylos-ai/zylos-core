/*
Protocol constraints adapted from zz-howard/chatweave @ 03e69a4435ce2f4913ed28884509f3db64d6ebcf,
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
// Internal interpreter for the fixed, embedded schema subset below. It is not
// a public or general-purpose JSON Schema evaluator and never evaluates code.
function matches(schema, value, document) {
  if (typeof schema === 'boolean') return schema;
  if (!object(schema)) return false;
  if (schema.$ref) {
    const ref = reference(schema.$ref, document);
    if (!matches(ref.schema, value, ref.document)) return false;
  }
  if (own(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => typeValid(type, value))) return false;
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && chars(value) < schema.minLength) return false;
    if (schema.maxLength !== undefined && chars(value) > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return false;
    if (schema.format && !formatValid(schema.format, value)) return false;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) return false;
  }
  if (object(value)) {
    if (schema.required?.some(key => !own(value, key))) return false;
    const names = Object.keys(value);
    if (schema.maxProperties !== undefined && names.length > schema.maxProperties) return false;
    if (schema.minProperties !== undefined && names.length < schema.minProperties) return false;
    for (const name of names) {
      if (schema.propertyNames && !matches(schema.propertyNames, name, document)) return false;
      if (schema.properties && own(schema.properties, name)) {
        if (!matches(schema.properties[name], value[name], document)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (object(schema.additionalProperties) && !matches(schema.additionalProperties, value[name], document)) return false;
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
    if (schema.items && value.some(item => !matches(schema.items, item, document))) return false;
  }
  if (schema.allOf?.some(item => !matches(item, value, document))) return false;
  if (schema.anyOf && !schema.anyOf.some(item => matches(item, value, document))) return false;
  if (schema.oneOf && schema.oneOf.filter(item => matches(item, value, document)).length !== 1) return false;
  if (schema.not && matches(schema.not, value, document)) return false;
  if (schema.if && !matches(matches(schema.if, value, document) ? schema.then ?? true : schema.else ?? true, value, document)) return false;
  return true;
}
function dataLimits(value) {
  const queue = [{ value, depth: 1 }];
  let nodes = 0;
  while (queue.length) {
    const item = queue.pop();
    if (++nodes > 5000 || item.depth > 6) return false;
    if (object(item.value) || Array.isArray(item.value)) {
      for (const child of Object.values(item.value)) queue.push({ value: child, depth: item.depth + 1 });
    }
  }
  return byteLength(JSON.stringify(value)) <= 65536;
}
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
function validBlock(block) {
  if (!matches(BLOCK_SCHEMA, block, BLOCK_SCHEMA) || !blockTypes.includes(block.type)) return false;
  if (!boundedBlockNodes(block)) return false;
  if (block.metadata?.provenance === 'adapter' && block.type !== 'markdown') return false;
  if (block.data && !dataLimits(block.data)) return false;
  if (block.type === 'form_intent' && block.schemaVersion === 2 && block.data
    && evaluateFormState(block.data.fields, {}).errors.length) return false;
  return block.type !== 'markdown' || !block.data || byteLength(block.data.text) <= 32768;
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
function validAction(action) {
  return matches(ACTION_SCHEMA.$defs.actionRequest, action, ACTION_SCHEMA) && action.protocolVersion === '0.1';
}
function validEnvelope(envelope) {
  if (!object(envelope) || envelope.version !== 1 || !id(envelope.messageId) || !string(envelope.fallbackText, 1, 16000)) return false;
  if (envelope.kind === 'message') {
    if (!keys(envelope, ['version', 'kind', 'messageId', 'fallbackText', 'blocks'], ['metadata', 'interruptId', 'questionSummary', 'interrupt'])
      || !Array.isArray(envelope.blocks) || envelope.blocks.length > 64 || !envelope.blocks.every(validBlock)
      || new Set(envelope.blocks.map(block => block.id)).size !== envelope.blocks.length
      || (own(envelope, 'metadata') && (!object(envelope.metadata) || !withinMetadataDepth(envelope.metadata)))) return false;
    const questionKeys = ['interruptId', 'questionSummary', 'interrupt'];
    if (questionKeys.every(key => !own(envelope, key))) return true;
    if (!questionKeys.every(key => own(envelope, key)) || !id(envelope.interruptId) || !string(envelope.questionSummary, 1, 500)
      || !keys(envelope.interrupt, ['blockId', 'reason'], ['otherInput'])
      || !['confirmation', 'input_required'].includes(envelope.interrupt.reason)
      || (own(envelope.interrupt, 'otherInput') && typeof envelope.interrupt.otherInput !== 'boolean')) return false;
    const block = envelope.blocks.find(item => item.id === envelope.interrupt.blockId);
    return !!block && interactive.includes(block.type) && (block.status ?? 'complete') === 'complete' && object(block.data) && (block.data.state?.status ?? 'open') === 'open'
      && envelope.interrupt.reason === (block.type === 'confirmation' ? 'confirmation' : 'input_required')
      && envelope.questionSummary === makeQuestionSummary(envelope);
  }
  if (envelope.kind === 'answer') {
    return keys(envelope, ['version', 'kind', 'messageId', 'fallbackText', 'interruptId', 'questionSummary', 'action', 'metadata'])
      && id(envelope.interruptId) && string(envelope.questionSummary, 1, 500) && validAction(envelope.action)
      && keys(envelope.metadata, ['zylos']) && keys(envelope.metadata.zylos, ['answerId'])
      && envelope.metadata.zylos.answerId === envelope.action.id;
  }
  if (envelope.kind === 'control') {
    if (!keys(envelope, ['version', 'kind', 'messageId', 'fallbackText', 'interruptId', 'control']) || !id(envelope.interruptId)) return false;
    const control = envelope.control;
    return object(control) && id(control.messageId)
      && (control.operation === 'stop' ? keys(control, ['operation', 'messageId'])
        : control.operation === 'replace' && keys(control, ['operation', 'messageId', 'replacementInterruptId'])
          && id(control.replacementInterruptId));
  }
  return false;
}

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
  const blockIds = new Set(blocks.map(block => block.id)), referenced = new Set(), parents = new Map();
  const children = node => node.type === 'section' ? [...(node.header ?? []), ...(node.body ?? []), ...(node.actions ?? [])]
    : node.type === 'block' ? [] : node.children;
  for (const node of nodes.values()) {
    if (node.type === 'block') {
      if (!blockIds.has(node.blockId)) return 'unknown_view_block';
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

export function parseC4Content(content) {
  const framed = readC4Envelope(content);
  if (framed.kind !== 'envelope') return framed;
  try {
    const split = splitMessageView(framed.envelope);
    if (!validEnvelope(split.envelope)) return { kind: 'invalid', reason: 'invalid_envelope' };
    const error = split.hasView ? viewError(split.view, split.metadata, split.envelope.blocks) : null;
    return { kind: 'envelope', envelope: split.envelope, suffix: framed.suffix,
      view: split.hasView && !error ? split.view : null, ...(error ? { viewError: error } : {}) };
  } catch { return { kind: 'invalid', reason: 'invalid_envelope' }; }
}

function validFieldValue(field, value) {
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
export function evaluateFormState(fields, values) {
  const invalid = reason => ({ activeKeys: [], errors: [reason] });
  if (!Array.isArray(fields) || !fields.length || fields.length > 12) return invalid('invalid_form_fields');
  if (!object(values)) return invalid('invalid_form_values');
  const byKey = new Map();
  for (const field of fields) {
    if (!matches(BLOCK_SCHEMA.$defs.formFieldV2, field, BLOCK_SCHEMA)) return invalid('invalid_form_field');
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
    if (own(condition, 'present') ? value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0)
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
export function validateFormFields(fields, values) {
  const state = evaluateFormState(fields, values);
  if (state.errors.length) return { activeKeys: state.activeKeys, errors: [], formError: state.errors[0] };
  const active = new Set(state.activeKeys), known = new Set(fields.map(field => field.key)), errors = [];
  for (const key of Object.keys(values)) {
    if (!known.has(key)) errors.push({ key, reason: 'unknown' });
    else if (!active.has(key)) errors.push({ key, reason: 'inactive' });
  }
  for (const field of fields) {
    if (!active.has(field.key)) continue;
    const value = own(values, field.key) ? values[field.key] : undefined;
    if (validFieldValue(field, value)) continue;
    let reason = 'type';
    if (value == null) reason = 'required';
    else if (['text', 'multiline_text'].includes(field.type) && typeof value === 'string') reason = 'range';
    else if (['number', 'integer'].includes(field.type) && typeValid(field.type, value)) reason = 'range';
    else if (field.type === 'single_select' && typeof value === 'string') reason = 'range';
    else if (field.type === 'multi_select' && Array.isArray(value) && value.every(item => typeof item === 'string')) reason = 'range';
    errors.push({ key: field.key, reason });
  }
  return { activeKeys: state.activeKeys, errors };
}

export function validateAnswer(action, questionEnvelope) {
  try {
    questionEnvelope = splitMessageView(questionEnvelope).envelope;
    if (!validAction(action) || !validEnvelope(questionEnvelope) || questionEnvelope.kind !== 'message' || !questionEnvelope.interrupt) return false;
    const block = questionEnvelope.blocks.find(item => item.id === questionEnvelope.interrupt.blockId), data = block.data;
    if (action.context.messageId !== questionEnvelope.messageId || action.context.blockId !== block.id
      || action.type !== data.action.type || action.target !== data.action.target || (data.state?.status ?? 'open') !== 'open') return false;
    const payload = action.payload;
    if (own(payload, 'freeText')) return questionEnvelope.interrupt.otherInput !== false;
    if (block.type === 'choice') {
      const selected = payload.selected;
      return ((data.selection ?? 'single') !== 'single' || selected.length === 1)
        && selected.length >= (data.minSelect ?? 1) && selected.length <= (data.maxSelect ?? data.options.length)
        && selected.every(value => data.options.some(option => option.id === value));
    }
    if (block.type === 'confirmation') return ['confirm', 'cancel'].includes(payload.outcome);
    if (block.type === 'form_intent') {
      if (block.schemaVersion === 2) {
        const result = validateFormFields(data.fields, payload.values);
        return !result.formError && result.errors.length === 0;
      }
      return Object.keys(payload.values).every(key => data.fields.some(field => field.key === key))
        && data.fields.every(field => validFieldValue(field, own(payload.values, field.key) ? payload.values[field.key] : undefined));
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
export const BLOCK_SCHEMA = {"type":"object","required":["id","type","schemaVersion"],"additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/blockId"},"type":{"enum":["markdown","time_series","breakdown","category_series","choice","confirmation","form_intent","x-zylos.image","x-zylos.file"]},"schemaVersion":{"enum":[1,2]},"data":{"type":"object"},"fallbackText":{"type":"string","maxLength":2000},"metadata":{"$ref":"#/$defs/blockMetadata"},"status":{"type":"string","enum":["complete","pending","error"]},"reason":{"type":"string","maxLength":500}},"allOf":[{"if":{"properties":{"type":{"not":{"const":"markdown"}}}},"then":{"required":["fallbackText"]}},{"if":{"properties":{"type":{"const":"markdown"}}},"then":{"properties":{"data":{"$ref":"#/$defs/markdownData"}}}},{"if":{"properties":{"type":{"const":"time_series"}}},"then":{"properties":{"data":{"$ref":"#/$defs/timeSeriesData"}}}},{"if":{"properties":{"type":{"const":"breakdown"}}},"then":{"properties":{"data":{"$ref":"#/$defs/breakdownData"}}}},{"if":{"properties":{"type":{"const":"category_series"}}},"then":{"properties":{"data":{"$ref":"#/$defs/categorySeriesData"}}}},{"if":{"properties":{"type":{"const":"choice"}}},"then":{"properties":{"data":{"$ref":"#/$defs/choiceData"}}}},{"if":{"properties":{"type":{"const":"confirmation"}}},"then":{"properties":{"data":{"$ref":"#/$defs/confirmationData"}}}},{"if":{"properties":{"type":{"const":"form_intent"},"schemaVersion":{"const":1}}},"then":{"properties":{"data":{"$ref":"#/$defs/formIntentData"}}}},{"if":{"properties":{"status":{"enum":["pending","error"]}},"required":["status"]},"then":{"required":["fallbackText"]},"else":{"required":["data"]}},{"if":{"properties":{"status":{"const":"error"}},"required":["status"]},"else":{"not":{"required":["reason"]}}},{"if":{"properties":{"metadata":{"properties":{"provenance":{"const":"adapter"}},"required":["provenance"]}},"required":["metadata"]},"then":{"properties":{"type":{"const":"markdown"}}}},{"if":{"properties":{"schemaVersion":{"const":2}}},"then":{"properties":{"type":{"const":"form_intent"},"data":{"$ref":"#/$defs/formIntentDataV2"}}}},{"if":{"properties":{"type":{"const":"x-zylos.image"}}},"then":{"required":["data"],"properties":{"schemaVersion":{"const":1},"status":{"const":"complete"},"data":{"$ref":"#/$defs/attachmentData"}}}},{"if":{"properties":{"type":{"const":"x-zylos.file"}}},"then":{"required":["data"],"properties":{"schemaVersion":{"const":1},"status":{"const":"complete"},"data":{"$ref":"#/$defs/attachmentData"}}}}],"$defs":{"blockId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"key":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"label":{"type":"string","minLength":1,"maxLength":120},"shortLabel":{"type":"string","minLength":1,"maxLength":24},"text":{"type":"string","maxLength":2000},"unit":{"type":"string","minLength":1,"maxLength":32},"scalar":{"type":["number","string","boolean","null"],"maxLength":500},"temporal":{"type":"string","anyOf":[{"format":"date"},{"format":"date-time"}]},"assessment":{"type":"object","required":["status"],"additionalProperties":false,"properties":{"status":{"type":"string","enum":["positive","negative","warning","critical","neutral","info"]},"label":{"$ref":"#/$defs/label"},"detail":{"$ref":"#/$defs/text"}}},"valueFormat":{"type":"object","additionalProperties":false,"properties":{"style":{"type":"string","enum":["decimal","integer","percent","currency","duration"]},"currency":{"type":"string","pattern":"^[A-Z]{3}$"},"minorUnits":{"type":"boolean"},"maximumFractionDigits":{"type":"integer","minimum":0,"maximum":6}}},"blockMetadata":{"type":"object","additionalProperties":false,"properties":{"provenance":{"type":"string","enum":["model","tool","host","adapter"]},"asOf":{"type":"string","format":"date-time"},"citations":{"type":"array","maxItems":10,"items":{"type":"object","required":["label"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"url":{"type":"string","format":"uri","maxLength":2000},"ref":{"type":"string","maxLength":128}}}},"host":{"type":"object","maxProperties":16}}},"blockState":{"type":"object","required":["status"],"additionalProperties":false,"properties":{"status":{"type":"string","enum":["open","resolved","expired","cancelled","superseded"]},"selected":{"type":"array","maxItems":10,"items":{"$ref":"action.schema.json#/$defs/optionId"},"minItems":1,"uniqueItems":true},"freeText":{"type":"string","maxLength":500,"minLength":1},"outcome":{"type":"string","enum":["confirm","cancel"]},"values":{"type":"object","maxProperties":12},"resolvedBy":{"type":"string","minLength":1,"maxLength":128},"resolvedAt":{"type":"string","format":"date-time"},"supersededBy":{"type":"string","maxLength":200},"reason":{"type":"object","required":["code"],"additionalProperties":false,"properties":{"code":{"type":"string","enum":["withdrawn","policy","record_changed","record_deleted","permission_changed","stopped","other"]},"text":{"type":"string","maxLength":200}}},"note":{"$ref":"#/$defs/text"}},"allOf":[{"if":{"properties":{"status":{"const":"resolved"}},"required":["status"]},"then":{"required":["resolvedAt"]}},{"if":{"properties":{"status":{"const":"cancelled"}},"required":["status"]},"then":{"required":["reason"]}},{"if":{"properties":{"status":{"enum":["cancelled","expired","superseded"]}},"required":["status"]},"then":{"not":{"required":["resolvedBy"]}}},{"if":{"properties":{"status":{"enum":["open","resolved"]}},"required":["status"]},"then":{"not":{"required":["reason"]}}},{"if":{"properties":{"status":{"const":"resolved"}},"required":["status"]},"then":{"oneOf":[{"required":["selected"],"not":{"anyOf":[{"required":["outcome"]},{"required":["values"]},{"required":["freeText"]}]}},{"required":["outcome"],"not":{"anyOf":[{"required":["selected"]},{"required":["values"]},{"required":["freeText"]}]}},{"required":["values"],"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]},{"required":["freeText"]}]}},{"required":["freeText"],"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]},{"required":["values"]}]}}]},"else":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]},{"required":["values"]},{"required":["freeText"]},{"required":["resolvedAt"]},{"required":["resolvedBy"]}]}}},{"if":{"properties":{"status":{"const":"superseded"}},"required":["status"]},"then":{"required":["supersededBy"]},"else":{"not":{"required":["supersededBy"]}}}]},"markdownData":{"type":"object","required":["text"],"additionalProperties":false,"properties":{"text":{"type":"string","maxLength":32768}}},"timeSeriesData":{"type":"object","required":["xType","series"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"xType":{"type":"string","enum":["date","datetime","number","category"]},"xLabel":{"$ref":"#/$defs/label"},"yLabel":{"$ref":"#/$defs/label"},"yUnit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"series":{"type":"array","minItems":1,"maxItems":6,"items":{"type":"object","required":["key","label","points"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"points":{"type":"array","maxItems":500,"items":{"type":"object","required":["x","y"],"additionalProperties":false,"properties":{"x":{"type":["string","number"],"maxLength":64},"y":{"type":["number","null"]}}}}}}},"summary":{"$ref":"#/$defs/text"}}},"breakdownData":{"type":"object","required":["parts"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"parts":{"type":"array","minItems":2,"maxItems":12,"items":{"type":"object","required":["key","label","value"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"value":{"type":"number","minimum":0},"mergedCount":{"type":"integer","minimum":2}}}},"asOf":{"$ref":"#/$defs/temporal"},"summary":{"$ref":"#/$defs/text"}}},"categorySeriesData":{"type":"object","required":["points"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"xLabel":{"$ref":"#/$defs/label"},"yLabel":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"points":{"type":"array","minItems":1,"maxItems":24,"items":{"type":"object","required":["key","label","value"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"value":{"type":["number","null"]},"assessment":{"$ref":"#/$defs/assessment"}}}},"reference":{"type":"object","required":["label","value"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"value":{"type":"number"}}},"summary":{"$ref":"#/$defs/text"}}},"option":{"type":"object","required":["id","label"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"label":{"$ref":"#/$defs/label"},"description":{"$ref":"#/$defs/text"}}},"choiceData":{"type":"object","required":["prompt","options","action"],"additionalProperties":false,"properties":{"prompt":{"$ref":"#/$defs/text"},"options":{"type":"array","minItems":2,"maxItems":10,"items":{"$ref":"#/$defs/option"}},"selection":{"type":"string","enum":["single","multiple"]},"minSelect":{"type":"integer","minimum":0,"maximum":10},"maxSelect":{"type":"integer","minimum":1,"maximum":10},"allowFreeText":{"type":"boolean"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"choice.select"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["outcome"]},{"required":["values"]}]}}}}]},"confirmationData":{"type":"object","required":["title","severity","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"body":{"$ref":"#/$defs/text"},"severity":{"type":"string","enum":["normal","destructive"]},"details":{"type":"array","maxItems":12,"items":{"type":"object","required":["label","value"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"value":{"$ref":"#/$defs/scalar"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"}}}},"confirmLabel":{"$ref":"#/$defs/shortLabel"},"cancelLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"confirmation.respond"}}}]},"state":{"$ref":"#/$defs/blockState"}},"if":{"properties":{"action":{"properties":{"requiresConfirmation":{"const":true}},"required":["requiresConfirmation"]}}},"then":{"properties":{"severity":{"const":"destructive"}}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["values"]}]}}}}]},"formField":{"type":"object","required":["key","label","type"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"type":{"type":"string","enum":["text","multiline_text","number","integer","date","datetime","boolean","single_select","multi_select"]},"required":{"type":"boolean"},"options":{"type":"array","maxItems":20,"items":{"$ref":"#/$defs/option"}},"min":{"type":"number"},"max":{"type":"number"},"maxLength":{"type":"integer","minimum":1,"maximum":2000},"unit":{"$ref":"#/$defs/unit"},"placeholder":{"$ref":"#/$defs/label"},"help":{"$ref":"#/$defs/text"},"defaultValue":{"anyOf":[{"$ref":"#/$defs/scalar"},{"type":"array","maxItems":20,"items":{"type":"string","maxLength":64}}]}},"allOf":[{"if":{"properties":{"type":{"enum":["single_select","multi_select"]}}},"then":{"required":["options"],"properties":{"options":{"minItems":1}}}}]},"formIntentData":{"type":"object","required":["fields","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"purpose":{"$ref":"#/$defs/text"},"fields":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/formField"}},"submitLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"form.submit"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]}]}}}}]},"activeWhen":{"oneOf":[{"type":"object","required":["field","eq"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"eq":{"type":["string","number","boolean"]}}},{"type":"object","required":["field","in"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"in":{"type":"array","minItems":1,"maxItems":20,"items":{"type":["string","number","boolean"]}}}},{"type":"object","required":["field","present"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"present":{"const":true}}}]},"formFieldV2":{"type":"object","required":["key","label","type"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"type":{"type":"string","enum":["text","multiline_text","number","integer","date","datetime","boolean","single_select","multi_select"]},"required":{"type":"boolean"},"options":{"type":"array","maxItems":20,"items":{"$ref":"#/$defs/option"}},"min":{"type":"number"},"max":{"type":"number"},"maxLength":{"type":"integer","minimum":1,"maximum":2000},"unit":{"$ref":"#/$defs/unit"},"placeholder":{"$ref":"#/$defs/label"},"help":{"$ref":"#/$defs/text"},"defaultValue":{"anyOf":[{"$ref":"#/$defs/scalar"},{"type":"array","maxItems":20,"items":{"type":"string","maxLength":64}}]},"activeWhen":{"$ref":"#/$defs/activeWhen"}},"allOf":[{"if":{"properties":{"type":{"enum":["single_select","multi_select"]}}},"then":{"required":["options"],"properties":{"options":{"minItems":1}}}}]},"formIntentDataV2":{"type":"object","required":["fields","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"purpose":{"$ref":"#/$defs/text"},"fields":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/formFieldV2"}},"submitLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"form.submit"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]}]}}}}]},"attachmentData":{"type":"object","required":["attachmentId","nameSnapshot"],"additionalProperties":false,"properties":{"attachmentId":{"type":"string","pattern":"^[A-Za-z0-9_-]{1,128}$"},"nameSnapshot":{"type":"string","minLength":1,"maxLength":160}}}}};
export const ACTION_SCHEMA = {"$defs":{"messageId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"},"blockId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"optionId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"actionId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$"},"actionType":{"type":"string","enum":["choice.select","confirmation.respond","form.submit"]},"target":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){0,3}$","maxLength":64},"actionSpec":{"type":"object","required":["type","target"],"additionalProperties":false,"properties":{"type":{"$ref":"#/$defs/actionType"},"target":{"$ref":"#/$defs/target"},"requiresConfirmation":{"type":"boolean"},"expiresAt":{"type":"string","format":"date-time"}},"if":{"properties":{"requiresConfirmation":{"const":true}},"required":["requiresConfirmation"]},"then":{"properties":{"type":{"const":"confirmation.respond"}}}},"actionContext":{"type":"object","required":["messageId","blockId"],"additionalProperties":false,"properties":{"conversationId":{"$ref":"#/$defs/messageId"},"messageId":{"$ref":"#/$defs/messageId"},"blockId":{"$ref":"#/$defs/blockId"}}},"choiceSelectPayload":{"type":"object","additionalProperties":false,"properties":{"selected":{"type":"array","items":{"$ref":"#/$defs/optionId"},"minItems":1,"maxItems":10,"uniqueItems":true},"freeText":{"$ref":"#/$defs/freeText"}},"oneOf":[{"required":["selected"]},{"required":["freeText"]}]},"freeText":{"type":"string","minLength":1,"maxLength":500},"confirmationRespondPayload":{"type":"object","additionalProperties":false,"properties":{"outcome":{"type":"string","enum":["confirm","cancel"]},"freeText":{"$ref":"#/$defs/freeText"}},"oneOf":[{"required":["outcome"]},{"required":["freeText"]}]},"formSubmitPayload":{"type":"object","additionalProperties":false,"oneOf":[{"required":["values"]},{"required":["freeText"]}],"properties":{"freeText":{"$ref":"#/$defs/freeText"},"values":{"type":"object","maxProperties":12,"propertyNames":{"pattern":"^[a-z][a-z0-9_]{0,31}$"},"additionalProperties":{"anyOf":[{"type":["string","number","boolean","null"],"maxLength":2000},{"type":"array","maxItems":20,"items":{"type":"string","maxLength":64}}]}}}},"actionRequest":{"type":"object","required":["id","protocolVersion","type","target","context","payload"],"additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/actionId"},"protocolVersion":{"type":"string","pattern":"^[0-9]+\\.[0-9]+$"},"type":{"$ref":"#/$defs/actionType"},"target":{"$ref":"#/$defs/target"},"context":{"$ref":"#/$defs/actionContext"},"payload":{"type":"object"},"clientTs":{"type":"string","format":"date-time"}},"allOf":[{"if":{"properties":{"type":{"const":"choice.select"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/choiceSelectPayload"}}}},{"if":{"properties":{"type":{"const":"confirmation.respond"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/confirmationRespondPayload"}}}},{"if":{"properties":{"type":{"const":"form.submit"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/formSubmitPayload"}}}}]}}};
export const CATALOG_SOURCE = {"coreCommit":"977958c913d19be5ebe80fa03a5133f61b4acbb9","chatweaveCommit":"03e69a4435ce2f4913ed28884509f3db64d6ebcf"};
export const HOST_SCHEMA_SOURCE = {"designCommit":"74b653a","viewSchemaVersion":1,"formSchemaVersion":2};
export const VIEW_SCHEMA = {"type":"object","required":["schemaVersion","root","nodes"],"additionalProperties":false,"properties":{"schemaVersion":{"const":1},"root":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"nodes":{"type":"array","minItems":1,"maxItems":128,"items":{"$ref":"#/$defs/node"}}},"$defs":{"node":{"oneOf":[{"type":"object","required":["id","type","children"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"type":{"const":"stack"},"children":{"type":"array","maxItems":128,"items":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"minItems":1},"gap":{"enum":["compact","normal"]}}},{"type":"object","required":["id","type","children"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"type":{"const":"columns"},"children":{"type":"array","maxItems":4,"items":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"minItems":2},"layout":{"enum":["balanced","sidebar"]}},"if":{"properties":{"layout":{"const":"sidebar"}},"required":["layout"]},"then":{"properties":{"children":{"minItems":2,"maxItems":2}}}},{"type":"object","required":["id","type"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"type":{"const":"section"},"header":{"type":"array","maxItems":128,"items":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"}},"body":{"type":"array","maxItems":128,"items":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"}},"actions":{"type":"array","maxItems":128,"items":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"}}},"anyOf":[{"required":["header"],"properties":{"header":{"minItems":1}}},{"required":["body"],"properties":{"body":{"minItems":1}}},{"required":["actions"],"properties":{"actions":{"minItems":1}}}]},{"type":"object","required":["id","type","blockId"],"additionalProperties":false,"properties":{"id":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"},"type":{"const":"block"},"blockId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"}}}]}}};
export const FORM_CONDITION_SCHEMA = {"oneOf":[{"type":"object","required":["field","eq"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"eq":{"type":["string","number","boolean"]}}},{"type":"object","required":["field","in"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"in":{"type":"array","minItems":1,"maxItems":20,"items":{"type":["string","number","boolean"]}}}},{"type":"object","required":["field","present"],"additionalProperties":false,"properties":{"field":{"type":"string","pattern":"^[a-z][a-z0-9_]{0,31}$"},"present":{"const":true}}}]};
export const COMPONENT_DEFINITIONS = [{"key":"markdown@1","type":"markdown","schemaVersion":1,"interactive":false,"description":"Text content. Use data.text for Markdown; keep the envelope fallback readable without a renderer.","parameters":{"type":"object","required":["text"],"additionalProperties":false,"properties":{"text":{"type":"string","maxLength":32768}}},"example":{"version":1,"kind":"message","messageId":"markdown_message","fallbackText":"可读消息","blocks":[{"id":"text","type":"markdown","schemaVersion":1,"data":{"text":"A readable message."}}]}},{"key":"time_series@1","type":"time_series","schemaVersion":1,"interactive":false,"description":"A bounded series chart with xType and one to six labeled series; each series has at most 500 x/y points.","parameters":{"type":"object","required":["xType","series"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"xType":{"type":"string","enum":["date","datetime","number","category"]},"xLabel":{"$ref":"#/$defs/label"},"yLabel":{"$ref":"#/$defs/label"},"yUnit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"series":{"type":"array","minItems":1,"maxItems":6,"items":{"type":"object","required":["key","label","points"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"points":{"type":"array","maxItems":500,"items":{"type":"object","required":["x","y"],"additionalProperties":false,"properties":{"x":{"type":["string","number"],"maxLength":64},"y":{"type":["number","null"]}}}}}}},"summary":{"$ref":"#/$defs/text"}}},"example":{"version":1,"kind":"message","messageId":"chart_message","fallbackText":"可读消息","blocks":[{"id":"chart","type":"time_series","schemaVersion":1,"data":{"xType":"date","series":[{"key":"usage","label":"用量","points":[{"x":"2026-11-01","y":1},{"x":"2026-11-02","y":null}]}]},"fallbackText":"用量图：首日1，次日未知"}]}},{"key":"breakdown@1","type":"breakdown","schemaVersion":1,"interactive":false,"description":"A nonnegative breakdown with two to twelve keyed, labeled parts.","parameters":{"type":"object","required":["parts"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"parts":{"type":"array","minItems":2,"maxItems":12,"items":{"type":"object","required":["key","label","value"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"value":{"type":"number","minimum":0},"mergedCount":{"type":"integer","minimum":2}}}},"asOf":{"$ref":"#/$defs/temporal"},"summary":{"$ref":"#/$defs/text"}}},"example":{"version":1,"kind":"message","messageId":"breakdown_message","fallbackText":"可读消息","blocks":[{"id":"parts","type":"breakdown","schemaVersion":1,"data":{"parts":[{"key":"a","label":"甲","value":2},{"key":"b","label":"乙","value":3}]},"fallbackText":"甲2，乙3"}]}},{"key":"category_series@1","type":"category_series","schemaVersion":1,"interactive":false,"description":"One to twenty-four keyed, labeled category values, including signed numbers or null for unavailable values.","parameters":{"type":"object","required":["points"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"xLabel":{"$ref":"#/$defs/label"},"yLabel":{"$ref":"#/$defs/label"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"},"points":{"type":"array","minItems":1,"maxItems":24,"items":{"type":"object","required":["key","label","value"],"additionalProperties":false,"properties":{"key":{"$ref":"#/$defs/key"},"label":{"$ref":"#/$defs/label"},"value":{"type":["number","null"]},"assessment":{"$ref":"#/$defs/assessment"}}}},"reference":{"type":"object","required":["label","value"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"value":{"type":"number"}}},"summary":{"$ref":"#/$defs/text"}}},"example":{"version":1,"kind":"message","messageId":"category_message","fallbackText":"可读消息","blocks":[{"id":"categories","type":"category_series","schemaVersion":1,"data":{"points":[{"key":"a","label":"甲","value":0},{"key":"b","label":"乙","value":null}]},"fallbackText":"甲0，乙未知"}]}},{"key":"choice@1","type":"choice","schemaVersion":1,"interactive":true,"description":"An explicit single- or multiple-choice question with two to ten options and a choice.select action. Selection constraints are validated against the saved question.","parameters":{"type":"object","required":["prompt","options","action"],"additionalProperties":false,"properties":{"prompt":{"$ref":"#/$defs/text"},"options":{"type":"array","minItems":2,"maxItems":10,"items":{"$ref":"#/$defs/option"}},"selection":{"type":"string","enum":["single","multiple"]},"minSelect":{"type":"integer","minimum":0,"maximum":10},"maxSelect":{"type":"integer","minimum":1,"maximum":10},"allowFreeText":{"type":"boolean"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"choice.select"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["outcome"]},{"required":["values"]}]}}}}]},"example":{"version":1,"kind":"message","messageId":"single_question","fallbackText":"选一个方案；等待用户回答。","blocks":[{"id":"question","type":"choice","schemaVersion":1,"data":{"prompt":"选一个方案","options":[{"id":"a","label":"方案甲"},{"id":"b","label":"方案乙"}],"action":{"type":"choice.select","target":"clarification.answer"}},"fallbackText":"选一个方案"}],"interruptId":"interrupt_single_question","questionSummary":"选一个方案","interrupt":{"blockId":"question","reason":"input_required"}}},{"key":"confirmation@1","type":"confirmation","schemaVersion":1,"interactive":true,"description":"An explicit confirm/cancel question with a confirmation.respond action. An action marked requiresConfirmation must use destructive severity.","parameters":{"type":"object","required":["title","severity","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"body":{"$ref":"#/$defs/text"},"severity":{"type":"string","enum":["normal","destructive"]},"details":{"type":"array","maxItems":12,"items":{"type":"object","required":["label","value"],"additionalProperties":false,"properties":{"label":{"$ref":"#/$defs/label"},"value":{"$ref":"#/$defs/scalar"},"unit":{"$ref":"#/$defs/unit"},"format":{"$ref":"#/$defs/valueFormat"}}}},"confirmLabel":{"$ref":"#/$defs/shortLabel"},"cancelLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"confirmation.respond"}}}]},"state":{"$ref":"#/$defs/blockState"}},"if":{"properties":{"action":{"properties":{"requiresConfirmation":{"const":true}},"required":["requiresConfirmation"]}}},"then":{"properties":{"severity":{"const":"destructive"}}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["values"]}]}}}}]},"example":{"version":1,"kind":"message","messageId":"confirmation_question","fallbackText":"确认执行？；等待用户回答。","blocks":[{"id":"question","type":"confirmation","schemaVersion":1,"data":{"title":"确认执行？","severity":"destructive","action":{"type":"confirmation.respond","target":"operation.confirm","requiresConfirmation":true}},"fallbackText":"确认执行？"}],"interruptId":"interrupt_confirmation_question","questionSummary":"确认执行？","interrupt":{"blockId":"question","reason":"confirmation"}}},{"key":"form_intent@1","type":"form_intent","schemaVersion":1,"interactive":true,"description":"A version-one form with one to twelve fields and a form.submit action. Fields may use text, multiline_text, number, integer, date, datetime, boolean, single_select or multi_select.","parameters":{"type":"object","required":["fields","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"purpose":{"$ref":"#/$defs/text"},"fields":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/formField"}},"submitLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"form.submit"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]}]}}}}]},"example":{"version":1,"kind":"message","messageId":"form_question","fallbackText":"登记信息；等待用户回答。","blocks":[{"id":"question","type":"form_intent","schemaVersion":1,"data":{"title":"登记信息","fields":[{"key":"name","label":"名字","type":"text","required":true,"maxLength":20},{"key":"count","label":"数量","type":"integer","min":1,"max":5},{"key":"tags","label":"标签","type":"multi_select","options":[{"id":"a","label":"甲"},{"id":"b","label":"乙"}]}],"action":{"type":"form.submit","target":"information.submit"}},"fallbackText":"登记信息"}],"interruptId":"interrupt_form_question","questionSummary":"登记信息","interrupt":{"blockId":"question","reason":"input_required"}}},{"key":"form_intent@2","type":"form_intent","schemaVersion":2,"interactive":true,"description":"A conditional form. Field activeWhen uses scalar eq/in or present:true; hidden upstream values are missing downstream. Submit only active keys.","parameters":{"type":"object","required":["fields","action"],"additionalProperties":false,"properties":{"title":{"$ref":"#/$defs/label"},"purpose":{"$ref":"#/$defs/text"},"fields":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/formFieldV2"}},"submitLabel":{"$ref":"#/$defs/shortLabel"},"action":{"allOf":[{"$ref":"action.schema.json#/$defs/actionSpec"},{"properties":{"type":{"const":"form.submit"}}}]},"state":{"$ref":"#/$defs/blockState"}},"allOf":[{"properties":{"state":{"not":{"anyOf":[{"required":["selected"]},{"required":["outcome"]}]}}}}]},"example":{"version":1,"kind":"message","messageId":"conditional_form_question","fallbackText":"登记主体信息；等待用户回答。","blocks":[{"id":"question","type":"form_intent","schemaVersion":2,"data":{"title":"登记主体信息","fields":[{"key":"customer_type","label":"主体类型","type":"single_select","required":true,"options":[{"id":"person","label":"个人"},{"id":"company","label":"企业"}]},{"key":"company_name","label":"公司名称","type":"text","required":true,"activeWhen":{"field":"customer_type","eq":"company"}}],"action":{"type":"form.submit","target":"information.submit"}},"fallbackText":"登记主体信息"}],"interruptId":"interrupt_conditional_form_question","questionSummary":"登记主体信息","interrupt":{"blockId":"question","reason":"input_required"}}}];
export const INTERACTIVE_COMPONENT_TYPES = ["choice","confirmation","form_intent"];
export const REGISTERED_COMPONENT_KEYS = ["markdown@1","time_series@1","breakdown@1","category_series@1","choice@1","confirmation@1","form_intent@1","form_intent@2"];
export const MODEL_INSTRUCTIONS = "C4 version 1; ChatWeave protocol 0.1. Use only the components listed below.\n\nSend the complete example envelope with the exact [C4-JSON] marker followed by a newline.\n\nReplace example values while preserving field constraints. Every non-markdown block needs fallbackText.\n\nInteractive messages need the matching interrupt and summary. Actions are checked against the stored question.\n\nParameter references resolve against BLOCK_SCHEMA.$defs or ACTION_SCHEMA.$defs in the same schema module.\n\nmarkdown@1: Text content. Use data.text for Markdown; keep the envelope fallback readable without a renderer.\nParameters: {\"type\":\"object\",\"required\":[\"text\"],\"additionalProperties\":false,\"properties\":{\"text\":{\"type\":\"string\",\"maxLength\":32768}}}\n\ntime_series@1: A bounded series chart with xType and one to six labeled series; each series has at most 500 x/y points.\nParameters: {\"type\":\"object\",\"required\":[\"xType\",\"series\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"xType\":{\"type\":\"string\",\"enum\":[\"date\",\"datetime\",\"number\",\"category\"]},\"xLabel\":{\"$ref\":\"#/$defs/label\"},\"yLabel\":{\"$ref\":\"#/$defs/label\"},\"yUnit\":{\"$ref\":\"#/$defs/unit\"},\"format\":{\"$ref\":\"#/$defs/valueFormat\"},\"series\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":6,\"items\":{\"type\":\"object\",\"required\":[\"key\",\"label\",\"points\"],\"additionalProperties\":false,\"properties\":{\"key\":{\"$ref\":\"#/$defs/key\"},\"label\":{\"$ref\":\"#/$defs/label\"},\"unit\":{\"$ref\":\"#/$defs/unit\"},\"points\":{\"type\":\"array\",\"maxItems\":500,\"items\":{\"type\":\"object\",\"required\":[\"x\",\"y\"],\"additionalProperties\":false,\"properties\":{\"x\":{\"type\":[\"string\",\"number\"],\"maxLength\":64},\"y\":{\"type\":[\"number\",\"null\"]}}}}}}},\"summary\":{\"$ref\":\"#/$defs/text\"}}}\n\nbreakdown@1: A nonnegative breakdown with two to twelve keyed, labeled parts.\nParameters: {\"type\":\"object\",\"required\":[\"parts\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"unit\":{\"$ref\":\"#/$defs/unit\"},\"format\":{\"$ref\":\"#/$defs/valueFormat\"},\"parts\":{\"type\":\"array\",\"minItems\":2,\"maxItems\":12,\"items\":{\"type\":\"object\",\"required\":[\"key\",\"label\",\"value\"],\"additionalProperties\":false,\"properties\":{\"key\":{\"$ref\":\"#/$defs/key\"},\"label\":{\"$ref\":\"#/$defs/label\"},\"value\":{\"type\":\"number\",\"minimum\":0},\"mergedCount\":{\"type\":\"integer\",\"minimum\":2}}}},\"asOf\":{\"$ref\":\"#/$defs/temporal\"},\"summary\":{\"$ref\":\"#/$defs/text\"}}}\n\ncategory_series@1: One to twenty-four keyed, labeled category values, including signed numbers or null for unavailable values.\nParameters: {\"type\":\"object\",\"required\":[\"points\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"xLabel\":{\"$ref\":\"#/$defs/label\"},\"yLabel\":{\"$ref\":\"#/$defs/label\"},\"unit\":{\"$ref\":\"#/$defs/unit\"},\"format\":{\"$ref\":\"#/$defs/valueFormat\"},\"points\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":24,\"items\":{\"type\":\"object\",\"required\":[\"key\",\"label\",\"value\"],\"additionalProperties\":false,\"properties\":{\"key\":{\"$ref\":\"#/$defs/key\"},\"label\":{\"$ref\":\"#/$defs/label\"},\"value\":{\"type\":[\"number\",\"null\"]},\"assessment\":{\"$ref\":\"#/$defs/assessment\"}}}},\"reference\":{\"type\":\"object\",\"required\":[\"label\",\"value\"],\"additionalProperties\":false,\"properties\":{\"label\":{\"$ref\":\"#/$defs/label\"},\"value\":{\"type\":\"number\"}}},\"summary\":{\"$ref\":\"#/$defs/text\"}}}\n\nchoice@1: An explicit single- or multiple-choice question with two to ten options and a choice.select action. Selection constraints are validated against the saved question.\nParameters: {\"type\":\"object\",\"required\":[\"prompt\",\"options\",\"action\"],\"additionalProperties\":false,\"properties\":{\"prompt\":{\"$ref\":\"#/$defs/text\"},\"options\":{\"type\":\"array\",\"minItems\":2,\"maxItems\":10,\"items\":{\"$ref\":\"#/$defs/option\"}},\"selection\":{\"type\":\"string\",\"enum\":[\"single\",\"multiple\"]},\"minSelect\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":10},\"maxSelect\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":10},\"allowFreeText\":{\"type\":\"boolean\"},\"action\":{\"allOf\":[{\"$ref\":\"action.schema.json#/$defs/actionSpec\"},{\"properties\":{\"type\":{\"const\":\"choice.select\"}}}]},\"state\":{\"$ref\":\"#/$defs/blockState\"}},\"allOf\":[{\"properties\":{\"state\":{\"not\":{\"anyOf\":[{\"required\":[\"outcome\"]},{\"required\":[\"values\"]}]}}}}]}\n\nconfirmation@1: An explicit confirm/cancel question with a confirmation.respond action. An action marked requiresConfirmation must use destructive severity.\nParameters: {\"type\":\"object\",\"required\":[\"title\",\"severity\",\"action\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"body\":{\"$ref\":\"#/$defs/text\"},\"severity\":{\"type\":\"string\",\"enum\":[\"normal\",\"destructive\"]},\"details\":{\"type\":\"array\",\"maxItems\":12,\"items\":{\"type\":\"object\",\"required\":[\"label\",\"value\"],\"additionalProperties\":false,\"properties\":{\"label\":{\"$ref\":\"#/$defs/label\"},\"value\":{\"$ref\":\"#/$defs/scalar\"},\"unit\":{\"$ref\":\"#/$defs/unit\"},\"format\":{\"$ref\":\"#/$defs/valueFormat\"}}}},\"confirmLabel\":{\"$ref\":\"#/$defs/shortLabel\"},\"cancelLabel\":{\"$ref\":\"#/$defs/shortLabel\"},\"action\":{\"allOf\":[{\"$ref\":\"action.schema.json#/$defs/actionSpec\"},{\"properties\":{\"type\":{\"const\":\"confirmation.respond\"}}}]},\"state\":{\"$ref\":\"#/$defs/blockState\"}},\"if\":{\"properties\":{\"action\":{\"properties\":{\"requiresConfirmation\":{\"const\":true}},\"required\":[\"requiresConfirmation\"]}}},\"then\":{\"properties\":{\"severity\":{\"const\":\"destructive\"}}},\"allOf\":[{\"properties\":{\"state\":{\"not\":{\"anyOf\":[{\"required\":[\"selected\"]},{\"required\":[\"values\"]}]}}}}]}\n\nform_intent@1: A version-one form with one to twelve fields and a form.submit action. Fields may use text, multiline_text, number, integer, date, datetime, boolean, single_select or multi_select.\nParameters: {\"type\":\"object\",\"required\":[\"fields\",\"action\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"purpose\":{\"$ref\":\"#/$defs/text\"},\"fields\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":12,\"items\":{\"$ref\":\"#/$defs/formField\"}},\"submitLabel\":{\"$ref\":\"#/$defs/shortLabel\"},\"action\":{\"allOf\":[{\"$ref\":\"action.schema.json#/$defs/actionSpec\"},{\"properties\":{\"type\":{\"const\":\"form.submit\"}}}]},\"state\":{\"$ref\":\"#/$defs/blockState\"}},\"allOf\":[{\"properties\":{\"state\":{\"not\":{\"anyOf\":[{\"required\":[\"selected\"]},{\"required\":[\"outcome\"]}]}}}}]}\n\nform_intent@2: A conditional form. Field activeWhen uses scalar eq/in or present:true; hidden upstream values are missing downstream. Submit only active keys.\nParameters: {\"type\":\"object\",\"required\":[\"fields\",\"action\"],\"additionalProperties\":false,\"properties\":{\"title\":{\"$ref\":\"#/$defs/label\"},\"purpose\":{\"$ref\":\"#/$defs/text\"},\"fields\":{\"type\":\"array\",\"minItems\":1,\"maxItems\":12,\"items\":{\"$ref\":\"#/$defs/formFieldV2\"}},\"submitLabel\":{\"$ref\":\"#/$defs/shortLabel\"},\"action\":{\"allOf\":[{\"$ref\":\"action.schema.json#/$defs/actionSpec\"},{\"properties\":{\"type\":{\"const\":\"form.submit\"}}}]},\"state\":{\"$ref\":\"#/$defs/blockState\"}},\"allOf\":[{\"properties\":{\"state\":{\"not\":{\"anyOf\":[{\"required\":[\"selected\"]},{\"required\":[\"outcome\"]}]}}}}]}";
const blockTypes = BLOCK_SCHEMA.properties.type.enum;
const interactive = INTERACTIVE_COMPONENT_TYPES;
// END GENERATED COMPONENT CATALOG
