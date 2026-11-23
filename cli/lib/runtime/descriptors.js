// Shared by Core and the Dashboard browser. Keep this module dependency-free.
// Additional runtimes must declare every capability unsupported until the
// corresponding callers stop dispatching to built-in implementations.
export const DEFAULT_RUNTIME = 'claude';

export const CAPABILITIES = Object.freeze(['modelOverride', 'accountQuota', 'usage', 'hookHealth']);

export const RUNTIME_DESCRIPTORS = Object.freeze([
  {
    id: 'claude',
    displayName: 'Claude',
    installPolicy: 'always',
    capabilities: { modelOverride: 'supported', accountQuota: 'supported', usage: 'supported', hookHealth: 'supported' },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    installPolicy: 'always',
    capabilities: { modelOverride: 'supported', accountQuota: 'supported', usage: 'supported', hookHealth: 'unsupported' },
  },
  {
    id: 'agy',
    displayName: 'Antigravity',
    installPolicy: 'whenUsed',
    capabilities: { modelOverride: 'unsupported', accountQuota: 'unsupported', usage: 'unsupported', hookHealth: 'supported' },
  },
].map(descriptor => Object.freeze({ ...descriptor, capabilities: Object.freeze(descriptor.capabilities) })));

export const SUPPORTED_RUNTIMES = Object.freeze(RUNTIME_DESCRIPTORS.map(({ id }) => id));
const displayNames = Object.fromEntries(RUNTIME_DESCRIPTORS.map(({ id, displayName }) => [id, displayName]));

const installPolicies = Object.fromEntries(RUNTIME_DESCRIPTORS.map(({ id, installPolicy }) => [id, installPolicy]));

export function runtimesWith(capability, value = 'supported') {
  if (!CAPABILITIES.includes(capability)) throw new TypeError('Unknown runtime capability');
  if (value !== 'supported' && value !== 'unsupported') throw new TypeError('Unknown capability value');
  return Object.freeze(RUNTIME_DESCRIPTORS
    .filter(({ capabilities }) => capabilities[capability] === value)
    .map(({ id }) => id));
}

export function runtimeDisplayName(id) {
  return typeof id === 'string' && Object.hasOwn(displayNames, id) ? displayNames[id] : id;
}

export function runtimeInstallPolicy(id) {
  return typeof id === 'string' && Object.hasOwn(installPolicies, id) ? installPolicies[id] : null;
}
