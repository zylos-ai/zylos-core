/** Internal character codec. Group grammar is validated separately. */
export const encodeGroupCharacters = value => value.replaceAll(':', '=').replaceAll('.', '+');
export function decodeGroupCharacters(value) {
  if (typeof value !== 'string' || /[:.]/.test(value)) return null;
  return value.replaceAll('=', ':').replaceAll('+', '.');
}
