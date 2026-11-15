// A count label reads in the singular for one (`<key>One`), when the language has that form; otherwise the plural.
export const counted = (labels, key, count) => count === 1 && labels[key + 'One'] ? labels[key + 'One'] : labels[key];

export function countLabel(t, key, count, params = { count }) {
  const one = key + 'One';
  const singular = count === 1 ? t(one, params) : one;
  return counted({ [key]: t(key, params), [one]: singular === one ? null : singular }, key, count);
}
