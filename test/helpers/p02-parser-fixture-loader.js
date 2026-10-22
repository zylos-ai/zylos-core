/** TEST ONLY: finite allow-list, NOT a P01 parser implementation or validation. */
let groups;
export function initialize(data) { groups = data.groups; }
export async function load(url, context, nextLoad) {
  if (url.endsWith('/skills/comm-bridge/scripts/c4-db.js')) {
    return { format: 'module', shortCircuit: true, source: `
      const groups = new Set(${JSON.stringify(groups)});
      export function parseSessionGroup(value) {
        if (!groups.has(value)) return null;
        const at = value.indexOf(':');
        return { namespace: at < 0 ? value : value.slice(0, at), groupName: at < 0 ? null : value.slice(at + 1) };
      }
    ` };
  }
  return nextLoad(url, context);
}
