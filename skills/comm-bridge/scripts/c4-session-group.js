// Pure group syntax; importing this module never opens a database.
const namespacePattern = /^[a-z][a-z0-9_-]{0,31}$/;
const localPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const contractError = Symbol('c4.contractError');
export function dataError(code, message, extra = {}) {
  const error = Object.assign(new Error(message), { code, persisted: [], ...extra });
  Object.defineProperty(error, contractError, { value: true });
  return error;
}
export const isDataError = error => error?.[contractError] === true;
export function validNamespace(value) {
  return typeof value === 'string' && namespacePattern.test(value) && !['origin', 'void', 'internal'].includes(value);
}
export function validateGroupName(groupName) {
  if (typeof groupName !== 'string') throw dataError('SESSION_GROUP_INVALID', 'Session group name must be a string; message was NOT stored.');
  if (groupName.length > 95) throw dataError('SESSION_GROUP_TOO_LONG', `Session group name is ${groupName.length} chars, over the 95-char limit (got: ${JSON.stringify(groupName.slice(0, 32))}). Message was NOT stored. Map the conversation to a unique shorter name; do not drop the group.`);
  if (!localPattern.test(groupName)) {
    const position = groupName.length === 0 ? 0 : !/^[A-Za-z0-9]/.test(groupName) ? 0 : groupName.search(/[^A-Za-z0-9_.:-]/);
    throw dataError('SESSION_GROUP_INVALID', `Invalid session group ${JSON.stringify(groupName)} at position ${position}: ${JSON.stringify(groupName[position] ?? '')}. Use a nonempty name starting with a letter or digit, followed by letters, digits, _, ., :, or -. Message was NOT stored; fix the component mapping, do not drop the group.`);
  }
}
export function composeSessionGroup(namespace, groupName) {
  if (!validNamespace(namespace)) throw dataError('SESSION_GROUP_INVALID', 'Invalid namespace');
  if (groupName === undefined) return namespace;
  validateGroupName(groupName);
  return `${namespace}:${groupName}`;
}
export function parseSessionGroup(value) {
  if (value === 'origin') return { namespace: 'origin', groupName: null };
  if (typeof value !== 'string' || value.length > 128) return null;
  const colon = value.indexOf(':');
  const namespace = colon < 0 ? value : value.slice(0, colon);
  const groupName = colon < 0 ? null : value.slice(colon + 1);
  if (!validNamespace(namespace) || (groupName !== null && (groupName.length > 95 || !localPattern.test(groupName)))) return null;
  return { namespace, groupName };
}
export function requireGroup(value, { global = false } = {}) {
  if (!(global && value === '*') && !parseSessionGroup(value)) throw dataError('SESSION_GROUP_INVALID', 'Invalid session group');
  return value;
}
