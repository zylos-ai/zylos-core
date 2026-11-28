const string = { type: 'string' };
const boolean = { type: 'boolean' };
const oneOf = (...values) => ({ type: 'string', enum: values });
const array = items => ({ type: 'array', items });
const c4Ids = array({ type: 'integer' });
const extractionFields = { topic: string, text: string, owner: boolean, source: string };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const DREAM_RESULT_SCHEMAS = {
  stage1: object({ groups: array(object({
    group: string, summary: { ...string, minLength: 1, maxLength: 600 },
    items: array({ anyOf: [
      object({ type: oneOf('project', 'decision', 'diary'), ...extractionFields }),
      object({ type: oneOf('rule'), ...extractionFields, c4_ids: c4Ids }),
    ] }),
  })) }),
  stage2: object({
    diary: string,
    rule_candidates: array(object({ text: string, source: string, owner_stated: boolean, c4_ids: c4Ids,
      destination: oneOf('rules', 'preferences', 'skill') })),
    pages_changed: array(string), pages_created: array(string), skipped: array(object({ item: string, why: string })),
  }),
  tidy: object({
    merged: array(object({ keep: string, archive: string, why: string })),
    uncertain: array(object({ pages: array(string), why: string })),
    read_not_merged: array(object({ pages: array(string), why: string })),
    status_changes: array(object({ page: string, from: oneOf('active'), to: oneOf('active', 'paused', 'completed', 'abandoned'), why: string })),
  }),
  condense: object({ body: { ...string, minLength: 1 } }),
};

function validate(schema, value, location) {
  if (schema.anyOf) {
    const variant = schema.anyOf.find(option => option.properties.type.enum.includes(value?.type));
    if (!variant) throw new Error(`${location}.type must be project, decision, diary or rule`);
    validate(variant, value, location);
    return;
  }
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
  const validType = schema.type === 'integer' ? Number.isSafeInteger(value) : typeof value === schema.type;
  if (!validType || (schema.enum && !schema.enum.includes(value))) {
    throw new Error(`${location} must be ${schema.enum?.join(' or ') ?? schema.type}`);
  }
  if (typeof value === 'string' && ([...value].length > (schema.maxLength ?? Infinity) || value.trim().length < (schema.minLength ?? 0))) {
    throw new Error(`${location} has invalid length`);
  }
}

export function parseDreamResult(stage, answer, batchGroups) {
  let result;
  try { result = JSON.parse(answer); } catch { throw new Error('Return one valid JSON object'); }
  validate(DREAM_RESULT_SCHEMAS[stage], result, 'Result');
  if (batchGroups) {
    const actual = new Set(result.groups.map(entry => entry.group));
    if (result.groups.length !== batchGroups.length || batchGroups.some(({ group }) => !actual.has(group))) {
      throw new Error('Return each input group exactly once');
    }
    const allowedByGroup = new Map(batchGroups.map(({ group, ids }) => [group, new Set(ids)]));
    for (const { group, items } of result.groups) {
      const allowed = allowedByGroup.get(group);
      for (const item of items) {
        if (item.type === 'rule') item.c4_ids = item.c4_ids.filter(id => allowed.has(id));
      }
    }
  }
  return result;
}
