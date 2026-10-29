const SECRET_PATTERNS = [
  'read_api_key',
  'read_session_token',
  'zylos_ak_',
  'zylos_st_'
];

const VALUE_SECRET_PATTERN = /zylos_(?:ak|st)_(?:[A-Za-z0-9_-]+|\.\.\.[A-Za-z0-9_-]+)?/g;
const SECRET_FIELD_NAME_PATTERN = /read_(?:api_key|session_token)/g;

export function assertFleetPayloadSafe(payload) {
  const serialized = JSON.stringify(payload);
  if (SECRET_PATTERNS.some((pattern) => serialized.includes(pattern))) {
    const err = new Error('fleet_secret_leak_guard');
    err.code = 'fleet_secret_leak_guard';
    throw err;
  }
}

function redactString(value) {
  return value
    .replace(VALUE_SECRET_PATTERN, '[redacted]')
    .replace(SECRET_FIELD_NAME_PATTERN, '[redacted]');
}

export function redactFleetPayload(payload) {
  if (typeof payload === 'string') return redactString(payload);
  if (Array.isArray(payload)) return payload.map(item => redactFleetPayload(item));
  if (payload && typeof payload === 'object') {
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [key, redactFleetPayload(value)])
    );
  }
  return payload;
}

export function buildFleetPayload({
  remoteFleet,
  selfRecord,
  nowIso = new Date().toISOString(),
  assertSafe = true
}) {
  const remoteAgents = Array.isArray(remoteFleet?.agents) ? remoteFleet.agents : [];
  const agents = [
    { ...selfRecord, self: true, access: 'admin' },
    ...remoteAgents.map((agent) => ({
      ...agent,
      self: agent.self === true,
      access: agent.access === 'admin' ? 'admin' : 'read'
    }))
  ];
  const payload = {
    ...(remoteFleet || {}),
    agents,
    count: agents.length,
    updated_at: remoteFleet?.updated_at || nowIso
  };
  if (assertSafe) assertFleetPayloadSafe(payload);
  return payload;
}

export function buildSafeFleetPayload(options) {
  const payload = buildFleetPayload({ ...options, assertSafe: false });
  try {
    assertFleetPayloadSafe(payload);
    return { payload, redacted: false };
  } catch (err) {
    if (err?.code !== 'fleet_secret_leak_guard') throw err;
    const redacted = redactFleetPayload(payload);
    assertFleetPayloadSafe(redacted);
    return { payload: redacted, redacted: true };
  }
}
