export function normalizeStatusEndpoint(endpoint) {
  const [base = '', ...parts] = (endpoint || '').split('|');
  return [base, ...parts.filter(part => !/^(msg|req|parent):/.test(part)).sort()].join('|');
}
