const string = { type: 'string' };
const boolean = { type: 'boolean' };
const oneOf = (...values) => ({ type: 'string', enum: values });
const array = items => ({ type: 'array', items });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const DREAM_RESULT_SCHEMAS = {
  stage1: object({ groups: array(object({
    group: string, summary: { ...string, minLength: 1, maxLength: 600 },
    items: array(object({ type: oneOf('project', 'decision', 'rule', 'diary'), topic: string, text: string,
      owner: boolean, source: string })),
  })) }),
  stage2: object({
    diary: string,
    rule_candidates: array(object({ text: string, source: string, owner_stated: boolean,
      destination: oneOf('rules', 'preferences', 'skill') })),
    pages_changed: array(string), pages_created: array(string), skipped: array(object({ item: string, why: string })),
  }),
  tidy: object({
    merged: array(object({ keep: string, archive: string, why: string })),
    uncertain: array(object({ pages: array(string), why: string })),
    read_not_merged: array(object({ pages: array(string), why: string })),
    status_changes: array(object({ page: string, from: oneOf('active'), to: oneOf('active', 'paused', 'completed', 'abandoned'), why: string })),
    condensed: array(string),
  }),
};

function validate(schema, value, location) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${location} must be an object`);
    for (const [key, item] of Object.entries(schema.properties)) validate(item, value[key], `${location}.${key}`);
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) throw new Error(`${location} has unexpected fields`);
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
    for (const [index, item] of value.entries()) validate(schema.items, item, `${location}[${index}]`);
    return;
  }
  if (typeof value !== schema.type || (schema.enum && !schema.enum.includes(value))) {
    throw new Error(`${location} must be ${schema.enum?.join(' or ') ?? schema.type}`);
  }
  if (typeof value === 'string' && ([...value].length > (schema.maxLength ?? Infinity) || value.trim().length < (schema.minLength ?? 0))) {
    throw new Error(`${location} has invalid length`);
  }
}

export function parseDreamResult(stage, answer, expectedGroups) {
  let result;
  try { result = JSON.parse(answer); } catch { throw new Error('Return one valid JSON object'); }
  validate(DREAM_RESULT_SCHEMAS[stage], result, 'Result');
  if (expectedGroups) {
    const actual = new Set(result.groups.map(entry => entry.group));
    if (result.groups.length !== expectedGroups.length || expectedGroups.some(group => !actual.has(group))) {
      throw new Error('Return each input group exactly once');
    }
  }
  return result;
}
