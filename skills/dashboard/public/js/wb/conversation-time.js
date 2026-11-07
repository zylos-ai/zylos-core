/** SQL timestamps have no offset because the history store writes UTC. */
export function asDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const timestamp = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : null;
}
