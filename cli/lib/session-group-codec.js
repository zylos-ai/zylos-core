/** Internal character codec. Group grammar remains owned by P01. */
export const encodeGroupCharacters = value => value.replaceAll(':', '=').replaceAll('.', '+');
export function decodeGroupCharacters(value) {
  if (typeof value !== 'string' || /[:.]/.test(value)) return null;
  return value.replaceAll('=', ':').replaceAll('+', '.');
}
