// Project the fixed members from the catalog's existing schema representation.
// Extra type/version branches are independent; constraints applying to v1 stay.
export function versionOneSubset(blockSchema, actionSchema, snapshot) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const block = clone(blockSchema), action = clone(actionSchema);
  const blockTypes = snapshot.BLOCK_SCHEMA.properties.type.enum;
  const actionTypes = snapshot.ACTION_SCHEMA.$defs.actionType.enum;
  const appliesToMembers = (rule, members, versioned) => {
    const properties = rule.if?.properties;
    if (properties?.type?.const && !members.includes(properties.type.const)) return false;
    if (versioned && properties?.schemaVersion?.const !== undefined && properties.schemaVersion.const !== 1) return false;
    return true;
  };
  block.properties.type.enum = block.properties.type.enum.filter(type => blockTypes.includes(type));
  if (block.properties.schemaVersion.enum) {
    const versions = block.properties.schemaVersion.enum.filter(version => version === 1);
    const { enum: ignored, ...constraints } = block.properties.schemaVersion;
    block.properties.schemaVersion = versions.length === 1 ? { ...constraints, const: 1 } : { ...constraints, enum: versions };
  }
  block.allOf = block.allOf.filter(rule => appliesToMembers(rule, blockTypes, true)).map(rule => {
    if (rule.if?.properties?.schemaVersion?.const !== 1) return rule;
    const copy = clone(rule);
    delete copy.if.properties.schemaVersion;
    if (copy.if.required) {
      copy.if.required = copy.if.required.filter(key => key !== 'schemaVersion');
      if (!copy.if.required.length) delete copy.if.required;
    }
    return copy;
  });
  block.$defs = Object.fromEntries(Object.keys(snapshot.BLOCK_SCHEMA.$defs).map(key => [key, block.$defs[key]]));
  action.$defs = Object.fromEntries(Object.keys(snapshot.ACTION_SCHEMA.$defs).map(key => [key, action.$defs[key]]));
  action.$defs.actionType.enum = action.$defs.actionType.enum.filter(type => actionTypes.includes(type));
  action.$defs.actionRequest.allOf = action.$defs.actionRequest.allOf.filter(rule => appliesToMembers(rule, actionTypes, false));
  return { BLOCK_SCHEMA: block, ACTION_SCHEMA: action };
}
