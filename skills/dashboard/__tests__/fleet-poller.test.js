import assert from 'node:assert/strict';
import test from 'node:test';
import { objectResponse, isObjectApi, flushObjectReads } from './fixtures/fleet-object-api.js';
import { agentColor } from '../src/lib/agent-color.js';
import { FleetPoller, SseEventParser, stateToFleetRecord } from '../src/lib/fleet-poller.js';
import { assertFleetPayloadSafe, buildFleetPayload, buildSafeFleetPayload, redactFleetPayload } from '../src/lib/fleet-payload.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' }
  });
}

test('fleet health probe accepts both minimal and detailed remote health objects', async () => {
  for (const body of [
    { ok: true, service: 'zylos-dashboard', bootId: 'remote-boot' },
    { ok: true, service: 'zylos-dashboard', uptimeSeconds: 42, event_loop: {}, source: {} }
  ]) {
    const poller = new FleetPoller(makeConfig([
      { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
    ]), { fetch: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer zylos_ak_secret');
      return jsonResponse(body);
    } });
    await poller._probeAgentLatency(poller.agents[0]);
    assert.equal(poller.getFleet().agents[0].link.quality, 'ok');
  }
});

function makeConfig(agents, fleet = {}) {
  return {
    fleet: {
      agents,
      timeout_ms: 50,
      jitter_ms: 0,
      ...fleet
    }
  };
}

function streamResponse(text, status = 200) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  }), { status, headers: { 'content-type': 'text/event-stream' } });
}

test('fleet poller exchanges token and derives safe agent records', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_secret', expires_at: new Date(120000).toISOString() });
    }
    assert.equal(options.headers.Authorization, 'Bearer zylos_st_secret');
    return objectResponse(url, { working: 1, todayCost: 4.56, sevenDayCost: 7.89,
      rows: [{ id: 'origin', displayName: 'Origin', channel: 'dashboard', runtime: 'claude', model: 'GPT-5',
        contextPct: 42, state: { kind: 'working' }, duration: null, mainAgent: 'busy', lastActivityAt: null, flags: {} }],
      instance: { default_runtime: 'claude', accounts: { claude: { used_percentage: 4, live: false, recordedAt: 1000 } },
        defaults: { claude: { model: 'configured', effort: 'high', threshold: 75 } }, versions: { zylos: { installed: '1.0.0', latest: '1.2.3', update: '1.2.3' } },
        resources: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 } } });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test/dashboard', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  const fleet = poller.getFleet();
  assert.equal(fleet.count, 1);
  assert.equal(fleet.agents[0].name, 'Remote');
  assert.equal(fleet.agents[0].color, agentColor('Remote').color);
  assert.equal(fleet.agents[0].hue, agentColor('Remote').hue);
  assert.equal(fleet.agents[0].state, 'BUSY');
  assert.equal(fleet.agents[0].rate_limit_7d_pct, 4);
  assert.equal(fleet.agents[0].rate_limit_7d_live, false);
  assert.equal(fleet.agents[0].rate_limit_7d_recorded_at, 1000);
  assert.equal(fleet.agents[0].activity, null, 'compact rows do not expose tool details');
  assert.equal(Object.hasOwn(fleet.agents[0], 'context_pct'), false);
  assert.equal(Object.hasOwn(fleet.agents[0], 'cost'), false);
  assert.equal(Object.hasOwn(fleet.agents[0], 'session_cost'), false);
  assert.equal(fleet.agents[0].daily_cost, 4.56);
  assert.equal(fleet.agents[0].weekly_cost, 7.89);
  assert.equal(Object.hasOwn(fleet.agents[0], 'model'), false);
  assert.equal(Object.hasOwn(fleet.agents[0], 'effort'), false);
  assert.equal(Object.hasOwn(fleet.agents[0], 'new_session_threshold'), false);
  assert.equal(fleet.agents[0].cpu_pct, 12);
  assert.equal(fleet.agents[0].mem_pct, 34);
  assert.equal(fleet.agents[0].disk_pct, 56);
  assert.equal(fleet.agents[0].has_upgrade, true);
  assert.equal(Object.hasOwn(fleet.agents[0], 'has_subagent'), false, 'compact rows omit Origin child fields');
  assert.equal(Object.hasOwn(fleet.agents[0], 'subagent_count'), false);
  assert.equal(fleet.agents[0].health_reason, 'ok');
  assert.equal(JSON.stringify(fleet).includes('zylos_ak_secret'), false);
  assert.equal(JSON.stringify(fleet).includes('zylos_st_secret'), false);
  assert.equal(calls[0].authorization, 'Bearer zylos_ak_secret');
  assert.equal(fleet.agents[0].self, false, 'external records must not be flagged self');
  assert.deepEqual(calls.slice(1).map(call => new URL(call.url).pathname).sort(),
    ['/dashboard/api/groups/counts', '/dashboard/api/groups/running', '/dashboard/api/instance', '/dashboard/api/usage/summary']);
});

test('fleet poller reports initial not-polled records without down link quality', () => {
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: async url => objectResponse(url), now: () => 0 });

  const record = poller.getFleet().agents[0];
  assert.equal(record.health_reason, 'not_polled');
  assert.equal(record.pulse_rate, null);
  assert.equal(record.link.quality, 'ok');
  assert.equal(record.link.reason, null);
});

test('fleet poller captures token exchange scope as agent access', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_admin', expires_at: new Date(120000).toISOString(), scope: 'admin' });
    }
    return objectResponse(url);
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  assert.equal(poller.getAgentAccess('Remote'), 'read');
  await poller.pollOnce();
  assert.equal(poller.getAgentAccess('Remote'), 'admin');
  assert.equal(poller.getFleet().agents[0].access, 'admin');
});

test('fleet poller does not cache stale tokens after same-name remove and re-add', async () => {
  const tokenRequests = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return new Promise(resolve => tokenRequests.push(resolve));
    }
    return objectResponse(url);
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_admin' }
  ]), { fetch: fetchImpl, now: () => 0 });

  const staleExchange = poller.getSessionToken('Remote');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(tokenRequests.length, 1);

  poller.removeAgent('Remote');
  const currentAgent = { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_read' };
  poller.agents.push(currentAgent);
  poller.agentGenerations.set('Remote', (poller.agentGenerations.get('Remote') || 0) + 1);
  tokenRequests[0](jsonResponse({
    token: 'zylos_st_admin',
    expires_at: new Date(120000).toISOString(),
    scope: 'admin'
  }));
  assert.equal(await staleExchange, 'zylos_st_admin');
  assert.equal(poller.getAgentAccess('Remote'), 'read');

  const currentExchange = poller.getSessionToken('Remote');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(tokenRequests.length, 2);
  tokenRequests[1](jsonResponse({
    token: 'zylos_st_read',
    expires_at: new Date(120000).toISOString(),
    scope: 'read'
  }));
  assert.equal(await currentExchange, 'zylos_st_read');
  assert.equal(poller.getAgentAccess('Remote'), 'read');
});

test('fleet poller treats missing or unknown scope as read access', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_read', expires_at: new Date(120000).toISOString(), scope: 'owner' });
    }
    return objectResponse(url);
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  assert.equal(poller.getAgentAccess('Remote'), 'read');
  assert.equal(poller.getFleet().agents[0].access, 'read');
});

test('fleet poller refreshes token after expiry and on state 401', async () => {
  let now = 0;
  let tokenCount = 0;
  let stateCount = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/auth/token')) {
      tokenCount += 1;
      return jsonResponse({ token: `zylos_st_${tokenCount}`, expires_at: new Date(now + 120000).toISOString() });
    }
    if (url.endsWith('/api/instance')) stateCount += 1;
    if (url.endsWith('/api/instance') && stateCount === 3) return jsonResponse({ error: 'expired' }, 401);
    return objectResponse(url);
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });

  await poller.pollOnce();
  assert.equal(tokenCount, 1);
  now = 70000;
  await poller.pollOnce();
  assert.equal(tokenCount, 2, 'token should refresh inside skew window');
  await poller.pollOnce();
  assert.equal(tokenCount, 3, 'state 401 should force token refresh');
  assert.equal(poller.getFleet().agents[0].health_reason, 'idle');
});

test('fleet poller falls back to ttl when expires_at is invalid', async () => {
  let now = 0;
  let tokenCount = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      tokenCount += 1;
      return jsonResponse({ token: `zylos_st_${tokenCount}`, expires_at: 'not-a-date', ttl_seconds: 3600 });
    }
    return objectResponse(url);
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });

  await poller.pollOnce();
  now = 3000;
  await poller.pollOnce();
  assert.equal(tokenCount, 1, 'invalid expires_at should not force every poll to exchange a token');
});

test('fleet poller maps token 404 and invalid key 401 without blocking other agents', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('old.example.test')) return jsonResponse({ error: 'not_found' }, 404);
    if (url.includes('bad.example.test')) return jsonResponse({ error: 'invalid_api_key' }, 401);
    if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    return objectResponse(url);
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Old', base_url: 'https://old.example.test', read_api_key: 'zylos_ak_old' },
    { name: 'Bad', base_url: 'https://bad.example.test', read_api_key: 'zylos_ak_bad' },
    { name: 'Good', base_url: 'https://good.example.test', read_api_key: 'zylos_ak_good' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  const byName = Object.fromEntries(poller.getFleet().agents.map(a => [a.name, a]));
  assert.equal(byName.Old.health_reason, 'version_unsupported');
  assert.equal(byName.Old.state, 'UNKNOWN');
  assert.equal(byName.Old.hue, agentColor('Old').hue);
  assert.equal(byName.Bad.health_reason, 'auth_failed');
  assert.equal(byName.Bad.state, 'OFFLINE');
  assert.equal(byName.Bad.hue, agentColor('Bad').hue);
  assert.equal(byName.Good.health_reason, 'idle');
  assert.equal(byName.Good.hue, agentColor('Good').hue);
});

test('fleet poller keeps quiet records online — no event-rate staleness (#180)', async () => {
  let now = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    return objectResponse(url);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });

  await poller.pollOnce();
  assert.equal(poller.getFleet().agents[0].health_reason, 'idle');
  // An idle agent legitimately pushes nothing for long stretches; elapsed
  // time without events must not flip it offline while the channel is alive.
  now = 10 * 60_000;
  assert.equal(poller.getFleet().agents[0].health_reason, 'idle');
  assert.equal(poller.getFleet().agents[0].state, 'IDLE');
});

test('fleet poller marks agent OFFLINE on poll failure, recovers on success (#180)', async () => {
  let fail = false;
  const fetchImpl = async (url) => {
    if (fail) throw new Error('connection refused');
    if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    return objectResponse(url);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  assert.equal(poller.getFleet().agents[0].state, 'IDLE');

  fail = true;
  await poller.pollOnce();
  assert.equal(poller.getFleet().agents[0].state, 'OFFLINE');
  assert.equal(poller.getFleet().agents[0].health_reason, 'unreachable');
  // Last-known metrics are preserved for display alongside the OFFLINE state.
  fail = false;
  await poller.pollOnce();
  assert.equal(poller.getFleet().agents[0].state, 'IDLE');
});

test('fleet poller records health-probe latency, p95, and caps the window at 20 samples', async () => {
  let now = 0;
  const durations = Array.from({ length: 21 }, (_v, i) => i + 1);
  const fetchImpl = async (url, options = {}) => {
    assert.match(url, /\/api\/health$/);
    assert.equal(options.headers.Authorization, 'Bearer zylos_ak_secret');
    now += durations.shift();
    return jsonResponse({ ok: true });
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ], { slow_threshold_ms: 999 }), { fetch: fetchImpl, now: () => now });
  const agent = poller.agents[0];
  poller._setSuccess(agent, { state: 'IDLE' });

  for (let i = 0; i < 21; i += 1) await poller._probeAgentLatency(agent);
  const link = poller.getFleet().agents[0].link;
  assert.equal(link.latency_ms, 21);
  assert.equal(link.latency_p95_ms, 20);
  assert.equal(link.quality, 'ok');
});

test('fleet poller health probe triggers slow while SSE remains healthy without fallback polling', async () => {
  let now = 0;
  let stateFetches = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/health')) {
      now += 120;
      return jsonResponse({ ok: true });
    }
    if (url.endsWith('/api/instance')) {
      stateFetches += 1;
      return objectResponse(url);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ], { slow_threshold_ms: 50 }), { fetch: fetchImpl, now: () => now });
  const agent = poller.agents[0];
  poller._setSuccess(agent, { state: 'BUSY' });

  for (let i = 0; i < 5; i += 1) await poller._probeAgentLatency(agent);
  await flushObjectReads();
  const record = poller.getFleet().agents[0];
  assert.equal(record.state, 'BUSY');
  assert.equal(record.link.quality, 'slow');
  assert.equal(record.link.latency_p95_ms, 120);
  assert.equal(stateFetches, 0, 'probe path must not depend on fallback state polling');
});

test('fleet poller health probe falls back to session token when read key is rejected', async () => {
  let now = 0;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.Authorization });
    if (url.endsWith('/api/health') && options.headers.Authorization === 'Bearer zylos_ak_secret') {
      return jsonResponse({ error: 'direct key rejected' }, 401);
    }
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_probe', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/health') && options.headers.Authorization === 'Bearer zylos_st_probe') {
      now += 25;
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });
  const agent = poller.agents[0];
  poller._setSuccess(agent, { state: 'IDLE' });

  await poller._probeAgentLatency(agent);
  const record = poller.getFleet().agents[0];
  assert.equal(record.link.latency_ms, 25);
  assert.equal(record.link.quality, 'ok');
  assert.ok(calls.some(call => call.url.endsWith('/api/auth/token')));
  assert.ok(calls.some(call => call.url.endsWith('/api/health') && call.authorization === 'Bearer zylos_st_probe'));
});

test('fleet poller health probe refreshes cached token after direct-key auth rejection', async () => {
  let now = 0;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.Authorization });
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_fresh', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/health') && options.headers.Authorization === 'Bearer zylos_ak_secret') {
      return jsonResponse({ error: 'direct key rejected' }, 401);
    }
    if (url.endsWith('/api/health') && options.headers.Authorization === 'Bearer zylos_st_fresh') {
      now += 15;
      return jsonResponse({ ok: true });
    }
    if (url.endsWith('/api/health') && options.headers.Authorization === 'Bearer zylos_st_stale') {
      throw new Error('stale token should not be reused');
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });
  const agent = poller.agents[0];
  poller.tokens.set('Remote', {
    token: 'zylos_st_stale',
    expiresAtMs: 120000,
    scope: 'read'
  });
  poller._setSuccess(agent, { state: 'IDLE' });

  await poller._probeAgentLatency(agent);
  const healthAuth = calls
    .filter(call => call.url.endsWith('/api/health'))
    .map(call => call.authorization);
  assert.deepEqual(healthAuth, ['Bearer zylos_ak_secret', 'Bearer zylos_st_fresh']);
  assert.equal(poller.getFleet().agents[0].link.quality, 'ok');
});

test('fleet poller degrades after two consecutive probe failures and resets on success', async () => {
  let now = 0;
  const outcomes = ['timeout', 'timeout', 'ok'];
  const fetchImpl = async (url) => {
    assert.match(url, /\/api\/health$/);
    const outcome = outcomes.shift();
    if (outcome === 'ok') {
      now += 10;
      return jsonResponse({ ok: true });
    }
    const err = new Error('timed out');
    err.name = 'AbortError';
    throw err;
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });
  const agent = poller.agents[0];
  poller._setSuccess(agent, { state: 'IDLE' });

  await poller._probeAgentLatency(agent);
  let record = poller.getFleet().agents[0];
  assert.equal(record.state, 'IDLE');
  assert.equal(record.link.quality, 'ok');

  await poller._probeAgentLatency(agent);
  record = poller.getFleet().agents[0];
  assert.equal(record.state, 'IDLE');
  assert.equal(record.pulse_rate, 1);
  assert.equal(record.link.quality, 'degraded');
  assert.equal(record.link.reason, 'timeout');

  await poller._probeAgentLatency(agent);
  record = poller.getFleet().agents[0];
  assert.equal(record.link.quality, 'ok');
  assert.equal(record.link.reason, null);
});

test('fleet poller quality precedence keeps stale and down ahead of degraded', async () => {
  let now = 0;
  const fetchImpl = async () => {
    const err = new Error('connection refused');
    err.cause = { code: 'ECONNREFUSED' };
    throw err;
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => now });
  const agent = poller.agents[0];
  poller._setSuccess(agent, { state: 'IDLE' });
  now = 20_000;

  await poller._probeAgentLatency(agent);
  await poller._probeAgentLatency(agent);
  let record = poller.getFleet().agents[0];
  assert.equal(record.link.quality, 'stale');
  assert.equal(record.link.reason, 'stale');

  poller._setFailure(agent, 'timeout');
  record = poller.getFleet().agents[0];
  assert.equal(record.link.quality, 'down');
  assert.equal(record.link.reason, 'timeout');
});

test('fleet poller classifies granular state fetch failures', async () => {
  const cases = [
    { name: 'Timeout', throwError: Object.assign(new Error('timeout'), { name: 'AbortError' }), reason: 'timeout' },
    { name: 'Refused', throwError: Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }), reason: 'conn_refused' },
    { name: 'Aggregate', throwError: Object.assign(new Error('refused'), { cause: { errors: [{ code: 'ECONNREFUSED' }] } }), reason: 'conn_refused' },
    { name: 'Auth', status: 401, reason: 'auth_failed' },
    { name: 'Server', status: 500, reason: 'unreachable' }
  ];
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    const item = cases.find(testCase => url.includes(testCase.name.toLowerCase()));
    if (item.throwError) throw item.throwError;
    return jsonResponse({ error: 'failed' }, item.status);
  };
  const poller = new FleetPoller(makeConfig(cases.map(item => ({
    name: item.name,
    base_url: `https://${item.name.toLowerCase()}.example.test`,
    read_api_key: 'zylos_ak_secret'
  }))), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  const byName = Object.fromEntries(poller.getFleet().agents.map(a => [a.name, a]));
  for (const item of cases) {
    assert.equal(byName[item.name].health_reason, item.reason);
    assert.equal(byName[item.name].link.quality, 'down');
  }
});

test('fleet poller maps token 404 to version_unsupported', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) return jsonResponse({ error: 'not_found' }, 404);
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Old', base_url: 'https://old.example.test', read_api_key: 'zylos_ak_old' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  const record = poller.getFleet().agents[0];
  assert.equal(record.health_reason, 'version_unsupported');
  assert.equal(record.link.quality, 'down');
});

test('fleet poller classifies 2xx invalid state payloads as bad_payload', async () => {
  const bodies = [
    { name: 'Empty', response: () => textResponse('', 200) },
    { name: 'Text', response: () => textResponse('not-json', 200) },
    { name: 'Object', response: () => jsonResponse({}) },
    { name: 'Array', response: () => jsonResponse([]) },
    { name: 'Null', response: () => jsonResponse(null) },
    { name: 'OkOnly', response: () => jsonResponse({ ok: true }) }
  ];
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    const item = bodies.find(testCase => url.includes(testCase.name.toLowerCase()));
    if (item) return item.response();
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig(bodies.map(item => ({
    name: item.name,
    base_url: `https://${item.name.toLowerCase()}.example.test`,
    read_api_key: 'zylos_ak_secret'
  }))), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  for (const record of poller.getFleet().agents) {
    assert.equal(record.health_reason, 'bad_payload', `${record.name} should fail shape validation`);
    assert.equal(record.link.quality, 'down');
    assert.equal(record.link.reason, 'bad_payload');
  }
});

test('fleet poller idle watchdog aborts half-open SSE and starts fallback polling (#180)', async t => {
  const timers = [];
  let sseController;
  t.after(() => { try { sseController?.close(); } catch { /* already closed */ } });
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (isObjectApi(url)) return objectResponse(url);
    if (url.endsWith('/api/stream')) {
      // Half-open connection: stream opens, then goes silent forever.
      return new Response(new ReadableStream({ start(c) { sseController = c; } }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ], { sse_idle_timeout_ms: 45_000 }), {
    fetch: fetchImpl,
    now: () => 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; }
  });

  const agent = poller.agents[0];
  t.after(() => poller.stop());
  poller.running = true;
  const stream = poller._streamState(agent);
  const controller = new AbortController();
  stream.controller = controller; // _connectSse wires this; mirrored here for a direct _runSse call
  const run = poller._runSse(agent, stream, controller.signal).catch(err => err);
  await new Promise(resolve => setTimeout(resolve, 0));

  const watchdog = timers.find(t => t.ms === 45_000 && !t.cleared);
  assert.ok(watchdog, 'idle watchdog should be armed after connect');
  assert.equal(stream.idleTimer, watchdog);

  watchdog.fn();
  assert.equal(controller.signal.aborted, true, 'watchdog should abort the half-open stream');
  assert.ok(stream.pollTimer, 'watchdog should start fallback polling');
  assert.ok(stream.reconnectTimer, 'watchdog should schedule a reconnect');
  poller.running = false;
  // A directly-constructed Response body does not observe fetch abort signals,
  // so close the stream to let the read loop notice signal.aborted and exit.
  sseController.close();
  await run;
});

test('Fleet does not substitute service tier or configured identity for runtime evidence', () => {
  const record = stateToFleetRecord({ name: 'codex' }, {
    runtime_info: { runtime: 'codex', model: null, effort: null, service_tier: 'priority', configured_model: 'gpt-5.6-sol', configured_effort: 'high' },
  });
  assert.equal(Object.hasOwn(record, 'model'), false);
  assert.equal(Object.hasOwn(record, 'effort'), false);
});

test('stateToFleetRecord produces a secret-free self record from local API state', () => {
  const name = 'zylos01';
  const record = stateToFleetRecord({
    name,
    color: agentColor(name)
  }, {
      state: 'BUSY',
      running_tools: [{ tool_name: 'Bash', tool_detail: 'npm test' }],
      active_subagents: [{ last_activity: 'Subagent active' }],
      runtime_info: { model: 'Opus 4.6', effort: 'high', codex_update: '0.137.0' },
      context_pct: 42,
      new_session_threshold: 75,
      session_cost: 1.23,
      daily_cost: 4.56,
      weekly_cost: 7.89,
      system_metrics: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 }
  }, {
    self: true,
    base_url: null,
    nowMs: 0
  });

  assert.equal(record.self, true);
  assert.equal(record.name, name);
  assert.equal(record.color, agentColor(name).color);
  assert.equal(record.hue, agentColor(name).hue);
  assert.equal(record.state, 'BUSY');
  assert.equal(record.activity, null, 'Fleet ignores Origin tool details');
  assert.equal(Object.hasOwn(record, 'context_pct'), false);
  assert.equal(Object.hasOwn(record, 'cost'), false);
  assert.equal(Object.hasOwn(record, 'session_cost'), false);
  assert.equal(record.daily_cost, 4.56);
  assert.equal(record.weekly_cost, 7.89);
  assert.equal(Object.hasOwn(record, 'model'), false);
  assert.equal(Object.hasOwn(record, 'effort'), false);
  assert.equal(Object.hasOwn(record, 'new_session_threshold'), false);
  assert.equal(record.cpu_pct, 12);
  assert.equal(record.mem_pct, 34);
  assert.equal(record.disk_pct, 56);
  assert.equal(record.has_upgrade, true);
  assert.equal(Object.hasOwn(record, 'has_subagent'), false, 'Fleet omits Origin child observations');
  assert.equal(Object.hasOwn(record, 'subagent_count'), false);
  assert.equal(record.base_url, null);
  assert.equal(record.pulse_rate, 1);
  assert.equal(record.health_reason, 'ok');
  assert.equal(record.last_seen, new Date(0).toISOString());
  assert.equal(JSON.stringify(record).includes('zylos_ak_'), false);
  assert.equal(JSON.stringify(record).includes('zylos_st_'), false);
});

test('stateToFleetRecord consumes daily and weekly costs without exposing a session cost', () => {
  const record = stateToFleetRecord({
    name: 'test',
    color: agentColor('test')
  }, {
    state: 'IDLE',
    session_cost: 1.23,
    daily_cost: 4.56,
    weekly_cost: 7.89
  }, {
    self: true,
    nowMs: 0
  });
  assert.equal(Object.hasOwn(record, 'session_cost'), false);
  assert.equal(record.daily_cost, 4.56);
  assert.equal(record.weekly_cost, 7.89);
});

test('state payloads give self and remote records the same reachability regardless of runtime state', () => {
  const agent = { name: 'a', color: agentColor('a') };
  for (const state of ['IDLE', 'BUSY', 'UNKNOWN', 'OFFLINE']) {
    const local = stateToFleetRecord(agent, { state }, { self: true, nowMs: 0 });
    const remote = stateToFleetRecord(agent, { state }, { nowMs: 0 });
    assert.equal(local.state, state);
    assert.equal(local.health_reason, state === 'IDLE' ? 'idle' : 'ok');
    assert.equal(local.pulse_rate, 1);
    assert.equal(local.health_reason, remote.health_reason);
    assert.equal(local.pulse_rate, remote.pulse_rate);
  }
});

test('self record injected into fleet is first, flagged, and order-independent', () => {
  // Simulate the /api/fleet handler composition: self prepended to poller output.
  const self = stateToFleetRecord({ name: 'local', color: agentColor('local') }, { state: 'IDLE' }, { self: true, nowMs: 0 });
  const external = [
    { name: 'remote1', self: false },
    { name: 'remote2', self: false }
  ];
  const agents = [self, ...external];
  assert.equal(agents[0].self, true);
  assert.equal(agents[0].name, 'local');
  assert.equal(agents.filter((a) => a.self === true).length, 1);
  assert.ok(agents.slice(1).every((a) => a.self === false));
});

test('buildFleetPayload includes self first and rejects leaked secrets', () => {
  const self = stateToFleetRecord({ name: 'local', color: agentColor('local') }, { state: 'IDLE' }, { self: true, nowMs: 0 });
  const payload = buildFleetPayload({
    selfRecord: self,
    remoteFleet: { agents: [{ name: 'remote', self: false }], count: 1, updated_at: '2026-06-09T00:00:00.000Z' }
  });
  assert.equal(payload.count, 2);
  assert.equal(payload.agents[0].name, 'local');
  assert.equal(payload.agents[0].self, true);
  assert.equal(payload.agents[0].access, 'admin');
  assert.equal(payload.agents[1].name, 'remote');
  assert.equal(payload.agents[1].self, false);
  assert.equal(payload.agents[1].access, 'read');

  assert.throws(() => buildFleetPayload({
    selfRecord: self,
    remoteFleet: { agents: [{ name: 'bad', read_api_key: 'zylos_ak_secret' }] }
  }), /fleet_secret_leak_guard/);
});

test('redactFleetPayload masks string-leaf secrets and passes the safety guard', () => {
  const self = stateToFleetRecord({ name: 'local', color: agentColor('local') }, { state: 'IDLE' }, { self: true, nowMs: 0 });
  const unsafe = buildFleetPayload({
    selfRecord: self,
    remoteFleet: {
      agents: [{
        name: 'remote',
        activity: 'saw zylos_ak_secret123, zylos_ak_, zylos_st_, zylos_ak_...abcd, read_api_key, read_api_keys, and myread_session_token in output',
        context_pct: 7,
        self: false
      }],
      count: 1,
      updated_at: '2026-06-09T00:00:00.000Z'
    },
    assertSafe: false
  });

  assert.throws(() => assertFleetPayloadSafe(unsafe), /fleet_secret_leak_guard/);
  const redacted = redactFleetPayload(unsafe);
  assert.doesNotThrow(() => assertFleetPayloadSafe(redacted));
  assert.equal(redacted.agents[1].activity, 'saw [redacted], [redacted], [redacted], [redacted], [redacted], [redacted]s, and my[redacted] in output');
  assert.equal(redacted.agents[1].context_pct, 7);
});

test('buildSafeFleetPayload redacts string-leaf leaks for shared HTTP and SSE payloads', () => {
  const self = stateToFleetRecord({ name: 'local', color: agentColor('local') }, { state: 'IDLE' }, { self: true, nowMs: 0 });
  const result = buildSafeFleetPayload({
    selfRecord: self,
    remoteFleet: {
      agents: [{
        name: 'remote',
        activity: 'mentions zylos_ak_ prefix and masked zylos_st_...abcd',
        self: false
      }]
    },
    nowIso: '2026-06-09T00:00:00.000Z'
  });

  assert.equal(result.redacted, true);
  assert.equal(result.payload.agents[1].activity, 'mentions [redacted] prefix and masked [redacted]');
  assert.doesNotThrow(() => assertFleetPayloadSafe(result.payload));
});

test('redactFleetPayload leaves object-key leaks fail-closed', () => {
  const redacted = redactFleetPayload({
    agents: [{ name: 'remote', zylos_ak_secret_key: 'value' }]
  });

  assert.equal(redacted.agents[0].zylos_ak_secret_key, 'value');
  assert.throws(() => assertFleetPayloadSafe(redacted), /fleet_secret_leak_guard/);
  assert.throws(() => buildSafeFleetPayload({
    selfRecord: { name: 'local', self: true },
    remoteFleet: { agents: [{ name: 'remote', zylos_ak_secret_key: 'value' }] }
  }), /fleet_secret_leak_guard/);
});

test('redactFleetPayload leaves clean payloads and non-string leaves unchanged', () => {
  const clean = {
    agents: [{ name: 'remote', context_pct: 12, nested: { ok: true, value: null } }],
    count: 1
  };

  assert.deepEqual(redactFleetPayload(clean), clean);
});

test('SseEventParser handles events, ids, comments, CRLF, bare CR, and multi-line data', () => {
  const events = [];
  const parser = new SseEventParser((event) => events.push(event));
  parser.push(': keepalive\r\nid: 7\r\nevent: groups\r\ndata: {"state":"BUSY"');
  parser.push('\r\ndata: ,"context_pct":42}\r\n\r\n');
  parser.push('event: groups\rdata: {"state":"IDLE"}\r\r');
  parser.flush();
  assert.deepEqual(events, [
    {
      event: 'groups',
      data: '{"state":"BUSY"\n,"context_pct":42}',
      id: '7'
    },
    {
      event: 'groups',
      data: '{"state":"IDLE"}',
      id: null
    }
  ]);
});

test('SseEventParser preserves event type when CRLF splits across chunks', () => {
  const events = [];
  const parser = new SseEventParser((event) => events.push(event));
  parser.push('event: groups\r');
  parser.push('\ndata: {"state":"BUSY"}\r\n\r\n');
  parser.flush();
  assert.deepEqual(events, [{
    event: 'groups',
    data: '{"state":"BUSY"}',
    id: null
  }]);
});

test('fleet poller SSE uses Bearer auth and groups updates records', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.Authorization });
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (isObjectApi(url)) return objectResponse(url, { working: 1 });
    if (url.endsWith('/api/stream')) {
      assert.equal(options.headers.Authorization, 'Bearer zylos_st_stream');
      assert.equal(url.includes('token='), false);
      return streamResponse('event: groups\ndata: {"state":"BUSY","context_pct":55,"session_cost":0.75}\n\n');
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller._runSse(poller.agents[0], poller._streamState(poller.agents[0]), new AbortController().signal).catch(() => {});
  await flushObjectReads();
  const record = poller.getFleet().agents[0];
  assert.equal(record.state, 'BUSY');
  assert.equal(Object.hasOwn(record, 'context_pct'), false);
  assert.equal(Object.hasOwn(record, 'session_cost'), false);
  assert.ok(calls.some(c => c.url.endsWith('/api/stream') && c.authorization === 'Bearer zylos_st_stream'));
});

test('fleet poller SSE auth_expired forces token refresh on reconnect', async () => {
  let tokenCount = 0;
  let streamCount = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      tokenCount += 1;
      return jsonResponse({ token: `zylos_st_${tokenCount}`, expires_at: new Date(120000).toISOString() });
    }
    if (isObjectApi(url)) return objectResponse(url, { working: streamCount > 1 ? 1 : 0 });
    if (url.endsWith('/api/stream')) {
      streamCount += 1;
      return streamResponse(streamCount === 1
        ? 'event: auth_expired\ndata: {}\n\n'
        : 'event: groups\ndata: {"state":"BUSY"}\n\n');
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });
  const agent = poller.agents[0];

  await assert.rejects(
    () => poller._runSse(agent, poller._streamState(agent), new AbortController().signal),
    /auth_expired/
  );
  await poller._runSse(agent, poller._streamState(agent), new AbortController().signal).catch(() => {});
  await flushObjectReads();
  assert.equal(tokenCount, 2);
  assert.equal(poller.getFleet().agents[0].state, 'BUSY');
});

test('fleet poller stop aborts active SSE fetch streams', async t => {
  let signal;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (isObjectApi(url)) return objectResponse(url);
    if (url.endsWith('/api/stream')) {
      signal = options.signal;
      return new Promise(() => {});
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  t.after(() => poller.stop());
  poller.start();
  await new Promise(resolve => setTimeout(resolve, 10));
  poller.stop();
  assert.equal(signal.aborted, true);
});

test('fleet poller SSE connect timeout clears connecting and starts recovery loops', async t => {
  const timers = [];
  const warnings = [];
  const logs = [];
  let streamSignal;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (isObjectApi(url)) return objectResponse(url);
    if (url.endsWith('/api/stream')) {
      streamSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ], { timeout_ms: 50 }), {
    fetch: fetchImpl,
    now: () => 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; }
  });
  const oldWarn = console.warn;
  const oldLog = console.log;
  console.warn = (msg) => warnings.push(String(msg));
  console.log = (msg) => logs.push(String(msg));
  try {
    const agent = poller.agents[0];
    t.after(() => poller.stop());
  poller.running = true;
    const stream = poller._streamState(agent);
    poller._connectSse(agent);
    await new Promise(resolve => setTimeout(resolve, 0));

    const deadline = timers.find(t => t.ms === 50);
    assert.ok(deadline, 'connect deadline should be armed');
    deadline.fn();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(streamSignal.aborted, true);
    assert.equal(stream.connecting, false);
    assert.equal(stream.connectingSince, null);
    assert.ok(stream.pollTimer, 'fallback polling should be started after connect timeout');
    assert.ok(stream.reconnectTimer, 'reconnect should be scheduled after connect timeout');
    assert.ok(warnings.some(line => line.includes('reason=timeout') && line.includes('retry_in_ms=1000')));
    assert.ok(logs.some(line => line.includes('fallback polling started') && line.includes('trigger=sse-failure')));
  } finally {
    console.warn = oldWarn;
    console.log = oldLog;
  }
});

test('fleet poller stream connect deadline is cleared once headers arrive', async () => {
  const timers = [];
  const fetchImpl = async () => streamResponse(': connected\n\n');
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ], { timeout_ms: 50 }), {
    fetch: fetchImpl,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; }
  });

  const resp = await poller._fetchStream(poller.agents[0], 'zylos_st_stream', new AbortController().signal);
  assert.equal(resp.status, 200);
  assert.equal(timers[0].ms, 50);
  assert.equal(timers[0].cleared, true);
});

test('fleet poller caller abort during connect phase still wins over connect deadline', async () => {
  let streamSignal;
  const fetchImpl = async (_url, options = {}) => {
    streamSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ], { timeout_ms: 50 }), { fetch: fetchImpl });
  const controller = new AbortController();

  const result = poller._fetchStream(poller.agents[0], 'zylos_st_stream', controller.signal).catch(err => err);
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  const err = await result;

  assert.equal(streamSignal.aborted, true);
  assert.equal(err.name, 'AbortError');
  assert.equal(err.reason, undefined);
});

test('fleet poller resumes fallback polling when SSE has no groups and stops after recovery', async t => {
  const timers = [];
  const cleared = new Set();
  let stateFetches = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/instance')) {
      stateFetches += 1;
      return objectResponse(url);
    }
    if (isObjectApi(url)) return objectResponse(url);
    if (url.endsWith('/api/stream')) {
      return streamResponse(': connected\n\n');
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), {
    fetch: fetchImpl,
    now: () => 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => cleared.add(timer)
  });
  const agent = poller.agents[0];
  t.after(() => poller.stop());
  poller.running = true;
  const stream = poller._streamState(agent);
  const run = poller._runSse(agent, stream, new AbortController().signal).catch(err => err);
  await new Promise(resolve => setTimeout(resolve, 0));
  const compatibilityTimer = timers.find(timer => timer.ms === poller.pollIntervalMs);
  assert.ok(compatibilityTimer, 'compatibility timer should be scheduled');

  compatibilityTimer.fn();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(stream.pollTimer, 'compatibility fallback should start polling');

  poller._handleSseEvent(agent, { event: 'groups', data: '{"state":"BUSY"}' });
  assert.equal(stream.pollTimer, null);
  assert.ok(cleared.has(compatibilityTimer));
  poller.running = false;
  await run;
});

test('fleet poller watchdog revives dead records and wedged connecting state', t => {
  let now = 0;
  const timers = [];
  const warnings = [];
  const logs = [];
  const poller = new FleetPoller(makeConfig([
    { name: 'Dead', base_url: 'https://dead.example.test', read_api_key: 'zylos_ak_secret' },
    { name: 'Wedged', base_url: 'https://wedged.example.test', read_api_key: 'zylos_ak_secret' }
  ], { poll_interval_ms: 100, timeout_ms: 50, sse_reconnect_max_ms: 100 }), {
    fetch: async url => objectResponse(url),
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; }
  });
  const oldWarn = console.warn;
  const oldLog = console.log;
  console.warn = (msg) => warnings.push(String(msg));
  console.log = (msg) => logs.push(String(msg));
  try {
    t.after(() => poller.stop());
  poller.running = true;
    now = 301;
    poller._checkSelfHeal(poller.agents[0]);
    const deadStream = poller._streamState(poller.agents[0]);
    assert.ok(deadStream.pollTimer);
    assert.ok(deadStream.reconnectTimer);
    assert.ok(warnings.some(line => line.includes('classification=dead') && line.includes('agent=Dead')));

    const wedgedStream = poller._streamState(poller.agents[1]);
    const controller = new AbortController();
    wedgedStream.connecting = true;
    wedgedStream.connectingSince = 0;
    wedgedStream.controller = controller;
    now = 301;
    poller._checkSelfHeal(poller.agents[1]);
    assert.equal(controller.signal.aborted, true);
    assert.equal(wedgedStream.connecting, false);
    assert.equal(wedgedStream.connectingSince, null);
    assert.ok(wedgedStream.pollTimer);
    assert.ok(wedgedStream.reconnectTimer);
    assert.ok(warnings.some(line => line.includes('classification=wedged-connecting') && line.includes('agent=Wedged')));
    assert.ok(logs.filter(line => line.includes('trigger=watchdog')).length >= 2);
  } finally {
    console.warn = oldWarn;
    console.log = oldLog;
  }
});

test('fleet poller watchdog no-ops for active, recovering, and fresh records', t => {
  let now = 0;
  const timers = [];
  const poller = new FleetPoller(makeConfig([
    { name: 'Reading', base_url: 'https://reading.example.test', read_api_key: 'zylos_ak_secret' },
    { name: 'Recovering', base_url: 'https://recovering.example.test', read_api_key: 'zylos_ak_secret' },
    { name: 'Fresh', base_url: 'https://fresh.example.test', read_api_key: 'zylos_ak_secret' }
  ], { poll_interval_ms: 100 }), {
    fetch: async url => objectResponse(url),
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; }
  });
  t.after(() => poller.stop());
  poller.running = true;
  now = 301;
  poller._streamState(poller.agents[0]).reading = true;
  poller._streamState(poller.agents[1]).reconnectTimer = { unref() {} };

  poller._checkSelfHeal(poller.agents[0]);
  poller._checkSelfHeal(poller.agents[1]);
  now = 100;
  poller._checkSelfHeal(poller.agents[2]);

  assert.equal(poller._streamState(poller.agents[0]).pollTimer, null);
  assert.equal(poller._streamState(poller.agents[1]).pollTimer, null);
  assert.equal(poller._streamState(poller.agents[2]).pollTimer, null);
  assert.equal(timers.length, 0);
});

test('fleet poller self-heal watchdog timer is stopped cleanly', t => {
  const timers = [];
  const poller = new FleetPoller(makeConfig([], { poll_interval_ms: 100 }), {
    fetch: async url => objectResponse(url),
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; }
  });

  t.after(() => poller.stop());
  poller.start();
  assert.equal(poller.watchdogTimer.ms, 100);
  poller.stop();
  assert.equal(timers[0].cleared, true);
  assert.equal(poller.watchdogTimer, null);
});

test('fleet poller onPoll receives safe remote fleet after poll cycle completion', async () => {
  let onPollFleet = null;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    }
    return objectResponse(url);
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), {
    fetch: fetchImpl,
    now: () => 0,
    onPoll: (fleet) => { onPollFleet = fleet; }
  });

  await poller.pollOnce();
  assert.equal(onPollFleet.count, 1);
  assert.equal(onPollFleet.agents[0].name, 'Remote');
  assert.equal(JSON.stringify(onPollFleet).includes('zylos_ak_secret'), false);
  assert.equal(JSON.stringify(onPollFleet).includes('zylos_st_ok'), false);
});

test('fleet poller first add from empty fleet starts live polling and streaming', async t => {
  const calls = [];
  let streamSignal = null;
  const fetchImpl = async (url, options = {}) => {
    calls.push(url);
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_added', expires_at: new Date(120000).toISOString(), scope: 'read' });
    }
    if (isObjectApi(url)) return objectResponse(url, { todayCost: 12 });
    if (url.endsWith('/api/stream')) {
      streamSignal = options.signal;
      return new Promise(() => {});
    }
    throw new Error(`unexpected URL ${url}`);
  };
  let pushedFleet = null;
  const poller = new FleetPoller(makeConfig([]), {
    fetch: fetchImpl,
    now: () => 0,
    onPoll: (fleet) => { pushedFleet = fleet; }
  });

  t.after(() => poller.stop());
  poller.start();
  assert.equal(poller.running, true);
  assert.equal(poller.getFleet().count, 0);
  poller.addAgent({ name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(poller.running, true);
  assert.equal(poller.getFleet().agents[0].name, 'Remote');
  assert.equal(poller.getFleet().agents[0].daily_cost, 12);
  for (const path of ['/api/instance', '/api/groups/counts', '/api/groups/running', '/api/usage/summary']) assert.ok(calls.some(url => url.endsWith(path)));
  assert.ok(calls.some(url => url.endsWith('/api/stream')));
  assert.ok(streamSignal, 'SSE stream should be opened for the first added agent');
  assert.equal(pushedFleet.agents.some(a => a.name === 'Remote'), true);
  poller.stop();
});

test('fleet poller remove prevents late SSE failures and stale reconnect timers from resurrecting agents', async t => {
  const timers = [];
  let rejectStream;
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      tokenCalls += 1;
      return jsonResponse({ token: 'zylos_st_removed', expires_at: new Date(120000).toISOString() });
    }
    if (isObjectApi(url)) return objectResponse(url);
    if (url.endsWith('/api/stream')) {
      return new Promise((_resolve, reject) => { rejectStream = reject; });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), {
    fetch: fetchImpl,
    now: () => 0,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; }
  });
  const agent = poller.agents[0];
  t.after(() => poller.stop());
  poller.running = true;
  poller._connectSse(agent);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(poller.streams.has('Remote'));

  poller._scheduleReconnect(agent);
  const staleReconnect = poller.streams.get('Remote').reconnectTimer;
  poller.removeAgent('Remote');
  rejectStream(new Error('late network failure'));
  await new Promise(resolve => setTimeout(resolve, 0));
  staleReconnect.fn();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(poller.streams.has('Remote'), false);
  assert.equal(poller.tokens.has('Remote'), false);
  assert.equal(poller.getFleet().agents.some(a => a.name === 'Remote'), false);
  assert.equal(tokenCalls, 1, 'late paths must not exchange a fresh token after removal');
});

test('fleet poller rejects a legacy state response instead of using its session metrics', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_ok', expires_at: new Date(120000).toISOString() });
    }
    return jsonResponse({
      state: 'IDLE',
      context_pct: 63.5,
      session_cost: 0.50
    });
  };

  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller.pollOnce();
  const record = poller.getFleet().agents[0];
  assert.equal(Object.hasOwn(record, 'context_pct'), false);
  assert.equal(record.health_reason, 'bad_payload');
});

// --- Fleet tile iteration 2: name-keyed identity color, activity feed, rate limits ---

test('stateToFleetRecord keys color/hue to the configured display name, not remote self-identity', () => {
  const record = stateToFleetRecord({
    name: 'Jinglever',
    base_url: 'https://example.com/dashboard'
  }, {
    state: 'IDLE',
    agent: { name: 'some-hostname.local', color: '#4f46e5', hue: 330 }
  }, { self: false, nowMs: 0 });

  assert.equal(record.color, agentColor('Jinglever').color);
  assert.equal(record.hue, agentColor('Jinglever').hue);
});

test('stateToFleetRecord still honours explicit per-agent color overrides from fleet config', () => {
  const record = stateToFleetRecord({
    name: 'Jinglever',
    color: '#123456',
    hue: 42
  }, {
    state: 'IDLE',
    agent: { hue: 330 }
  }, { self: false, nowMs: 0 });

  assert.equal(record.color, '#123456');
  assert.equal(record.hue, 42);
});

test('Fleet does not read raw Origin activity or subagent observations', () => {
  for (const state of ['BUSY', 'IDLE']) {
    const input = { state };
    for (const field of ['running_tools', 'active_subagents', 'subagent_count', 'last_message', 'last_prompt', 'reason']) {
      Object.defineProperty(input, field, { get() { assert.fail(`raw Origin observation read: ${field}`); } });
    }
    const record = stateToFleetRecord({ name: 'a' }, input);
    assert.equal(record.activity, null);
    assert.equal(Object.hasOwn(record, 'has_subagent'), false);
    assert.equal(Object.hasOwn(record, 'subagent_count'), false);
    assert.deepEqual(record.activity_feed, []);
  }
});

test('stateToFleetRecord does not infer activity from an aggregate busy state', () => {
  const busy = stateToFleetRecord({ name: 'a' }, { state: 'BUSY', running_tools: [] }, { self: false, nowMs: 0 });
  assert.equal(busy.state, 'BUSY');
  assert.deepEqual(busy.activity_feed, []);

  const idle = stateToFleetRecord({ name: 'a' }, { state: 'IDLE' }, { self: false, nowMs: 0 });
  assert.deepEqual(idle.activity_feed, []);
});

test('stateToFleetRecord passes rate limit percentages through, defaulting to null', () => {
  const withRates = stateToFleetRecord({ name: 'a' }, {
    state: 'IDLE', rate_limit_pct: 13, rate_limit_7d_pct: 9,
    rate_limit_7d_live: false, rate_limit_7d_recorded_at: 1000
  }, { self: false, nowMs: 0 });
  assert.equal(withRates.rate_limit_pct, 13);
  assert.equal(withRates.rate_limit_7d_pct, 9);
  assert.equal(withRates.rate_limit_7d_live, false);
  assert.equal(withRates.rate_limit_7d_recorded_at, 1000);

  const without = stateToFleetRecord({ name: 'a' }, { state: 'IDLE' }, { self: false, nowMs: 0 });
  assert.equal(without.rate_limit_pct, null);
  assert.equal(without.rate_limit_7d_pct, null);
  assert.equal(without.rate_limit_7d_live, null);
  assert.equal(without.rate_limit_7d_recorded_at, null);
});

test('sleeping Origin remains online in Fleet', () => {
  const row = stateToFleetRecord({ name: 'Origin' }, { state: 'SLEEPING' }, { self: true });
  assert.equal(row.state, 'SLEEPING'); assert.equal(row.pulse_rate, 1); assert.equal(row.health_reason, 'ok');
});

// Injected transport and clock: no listener, real fetch, probe loop or subprocess.
// Run for latency sampling/serialization changes; skip unrelated fleet settings.
test('latency gaps stay in order while latest-success values and p95 skip failures', async () => {
  let now = 1000, probe = 0;
  const durations = [10, null, 30, null, 20];
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ], { slow_threshold_ms: 1 }), { now: () => now, fetch: async () => {
    const ms = durations[probe++];
    now += ms ?? 5;
    if (ms === null) throw new Error('offline');
    return jsonResponse({ ok: true });
  } });
  const agent = poller.agents[0];
  poller._setSuccess(agent, { state: 'IDLE' });
  for (let i = 0; i < durations.length; i++) await poller._probeAgentLatency(agent);
  const record = poller.getFleet().agents[0];
  assert.equal(record.latency.samples.length, 5);
  assert.deepEqual(record.latency.samples.map(row => row.ms), durations);
  assert.equal(record.link.latency_ms, 20);
  assert.equal(record.link.latency_p95_ms, 30);
  assert.equal(record.link.quality, 'ok', 'slow classification still needs five successful probes');
  assert.equal(record.link.sampled_at, record.latency.samples[4].at);
  for (let i = 1; i < 5; i++) assert.ok(record.latency.samples[i].at > record.latency.samples[i - 1].at);
});

test('all failed latency samples cap at twenty and retain last-success meaning', async () => {
  let now = 1000, failed = false;
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { now: () => now, fetch: async () => {
    now += 10;
    if (failed) throw new Error('offline');
    return jsonResponse({ ok: true });
  } });
  const agent = poller.agents[0];
  poller._setSuccess(agent, { state: 'IDLE' });
  await poller._probeAgentLatency(agent);
  const successAt = poller.getFleet().agents[0].link.sampled_at;
  failed = true;
  await poller._probeAgentLatency(agent);
  const mixed = poller.getFleet().agents[0];
  assert.equal(mixed.link.latency_ms, 10);
  assert.equal(mixed.link.sampled_at, successAt);
  for (let i = 0; i < 24; i++) await poller._probeAgentLatency(agent);
  const allFailed = poller.getFleet().agents[0];
  assert.equal(allFailed.latency.samples.length, 20);
  assert.ok(allFailed.latency.samples.every(row => row.ms === null));
  assert.equal(allFailed.link.latency_ms, null);
  assert.equal(allFailed.link.latency_p95_ms, null);
  assert.equal(allFailed.link.sampled_at, null);
});
test('fleet keeps only boolean supervisor pause observations and clears on recovery', () => {
  for (const mode of ['single', 'multi']) for (const value of [true, false, null, undefined, 'true', {}]) {
    const record = stateToFleetRecord({ name: 'fixture' }, { state: 'IDLE', session_mode: mode, supervisor_paused: value });
    assert.equal(record.supervisor_paused, typeof value === 'boolean' ? value : null);
  }
});

test('object API fetch failures never fall back to a retired remote path', async () => {
  for (const unavailable of ['/api/instance', '/api/groups/counts', '/api/groups/running', '/api/usage/summary']) {
    const calls = [];
    const poller = new FleetPoller(makeConfig([
      { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'fixture-key' }
    ]), { now: () => 0, fetch: async url => {
      const route = new URL(url).pathname;
      calls.push(route);
      if (route === '/api/auth/token') return jsonResponse({ token: 'fixture-session' });
      if (route === unavailable) return jsonResponse({ error: 'not_found' }, 404);
      return objectResponse(url);
    } });
    await poller.pollOnce();
    assert.equal(poller.getFleet().agents[0].health_reason, 'unreachable', unavailable);
    assert.equal(calls.length, 5);
    assert.equal(calls.some(route => route === '/api/state'), false);
    for (const route of ['/api/instance', '/api/groups/counts', '/api/groups/running', '/api/usage/summary']) assert.equal(calls.filter(call => call === route).length, 1);
  }
});

test('both instance and group events refresh all object observations without trusting event data', async () => {
  const calls = [];
  let working = 0, cost = 1;
  const agent = { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'fixture-key' };
  const poller = new FleetPoller(makeConfig([agent]), { now: () => 0, fetch: async url => {
    const route = new URL(url).pathname;
    calls.push(route);
    if (route === '/api/auth/token') return jsonResponse({ token: 'fixture-session' });
    return objectResponse(url, { working, todayCost: cost });
  } });
  await poller.pollOnce();
  assert.equal(poller.getFleet().agents[0].state, 'IDLE');
  for (const event of ['instance', 'groups']) {
    calls.length = 0;
    working++;
    cost++;
    poller._handleSseEvent(agent, { event, data: JSON.stringify({ state: 'OFFLINE', daily_cost: -100 }) });
    await flushObjectReads();
    const record = poller.getFleet().agents[0];
    assert.equal(record.state, 'BUSY');
    assert.equal(record.daily_cost, cost);
    assert.deepEqual(calls.sort(), ['/api/groups/counts', '/api/groups/running', '/api/instance', '/api/usage/summary']);
  }
});

test('object reads reject incomplete counts and usage as bad payloads', async () => {
  for (const [path, body] of [
    ['/api/groups/counts', { running: { states: {} } }],
    ['/api/groups/running', { rows: null }],
    ['/api/usage/summary', {}],
    ['/api/usage/summary', { today: { cost: 'bad' }, sevenDay: { cost: 2 } }],
  ]) {
    const poller = new FleetPoller(makeConfig([
      { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'fixture-key' }
    ]), { now: () => 0, fetch: async url => {
      if (url.endsWith('/api/auth/token')) return jsonResponse({ token: 'fixture-session' });
      return url.endsWith(path) ? jsonResponse(body) : objectResponse(url);
    } });
    await poller.pollOnce();
    assert.equal(poller.getFleet().agents[0].health_reason, 'bad_payload', path);
  }
});

test('object events received during a Fleet read schedule one later read without losing the final change', async t => {
  const poller = new FleetPoller(makeConfig([{ name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'fixture' }]));
  t.after(() => poller.stop());
  const agent = poller.agents[0], stream = poller._streamState(agent);
  poller.running = true;
  let reads = 0; const releases = [];
  t.mock.method(poller, '_pollAgentAndNotify', async () => { reads++; await new Promise(resolve => releases.push(resolve)); });
  poller._handleSseEvent(agent, { event: 'groups' });
  poller._handleSseEvent(agent, { event: 'instance' });
  poller._handleSseEvent(agent, { event: 'groups' });
  assert.equal(reads, 1);
  releases.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2, 'events during the held read require one follow-up after it');
  poller._handleSseEvent(agent, { event: 'groups' });
  releases.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 3, 'a later event during the second read is not lost either');
  releases.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 3); assert.equal(stream.objectReadPending, false); assert.equal(stream.objectReadDirty, false);
});

// The adapter consumes the public compact list, even if a caller accidentally
// retains a raw observation alongside it. Accessors make regressions observable.
test('object adapter uses mode, versions and resources while omitting all Origin session metadata', async () => {
  const { fleetStateFromObjects } = await import('../src/lib/fleet-poller.js');
  const row = { id: 'origin', model: null, contextPct: 12, state: { kind: 'unknown' }, flags: {} };
  for (const key of ['tools', 'working', 'rotationThreshold', 'presence', 'sessionGroup', 'noResponse', 'attention']) {
    Object.defineProperty(row, key, { get() { assert.fail(`raw group field read: ${key}`); } });
  }
  const instance = { session_mode: { sessionMode: 'multi' }, default_runtime: 'codex',
    defaults: { codex: { model: 'configured', effort: 'high', threshold: 80 } },
    versions: { codex: { installed: '1', latest: '2', update: '2' } },
    resources: { cpu_pct: 10, mem_pct: 20, disk_pct: 30, scope: 'mixed', cpu_source: 'container', mem_source: 'host' } };
  const counts = { listKnown: true, running: { total: 1, states: { working: 0, idle: 0, starting: 0, stopping: 0, unknown: 1 } } };
  const usage = { today: { cost: 1 }, sevenDay: { cost: 2 } };
  const projected = fleetStateFromObjects(instance, counts, usage, { rows: [row] });
  const record = stateToFleetRecord({}, projected);
  assert.equal(record.session_mode, 'multi');
  assert.equal(record.state, 'UNKNOWN');
  assert.equal(record.group_summary.running, counts.running.total);
  assert.equal(record.group_summary.counts.unknown, 1);
  assert.equal(Object.hasOwn(record, 'context_pct'), false);
  assert.equal(Object.hasOwn(record, 'model'), false);
  assert.equal(Object.hasOwn(record, 'effort'), false);
  assert.equal(Object.hasOwn(record, 'new_session_threshold'), false);
  row.model = 'observed-model';
  assert.equal(Object.hasOwn(stateToFleetRecord({}, fleetStateFromObjects(instance, counts, usage, { rows: [row] })), 'model'), false, 'Fleet omits even an observed Origin model');
  assert.equal(record.has_upgrade, true);
  assert.deepEqual([record.cpu_pct, record.mem_pct, record.disk_pct], [10, 20, 30]);
  for (const session_mode of ['multi', null, {}, { sessionMode: 'invalid' }]) {
    assert.throws(() => fleetStateFromObjects({ ...instance, session_mode }, counts, usage, { rows: [row] }), /bad_payload/);
  }
});


test('Fleet object projection never reads Origin session information or fetches its detail', async () => {
  const { fleetStateFromObjects } = await import('../src/lib/fleet-poller.js');
  const row = { id: 'origin', displayName: 'Origin', state: { kind: 'working' }, flags: {} };
  for (const key of ['model', 'effort', 'contextPct', 'rotationThreshold', 'currentAction']) {
    Object.defineProperty(row, key, { get() { assert.fail(`Origin session field read: ${key}`); } });
  }
  const instance = { session_mode: { sessionMode: 'single' } };
  const counts = { listKnown: true, running: { total: 1, states: { working: 1, idle: 0, starting: 0, stopping: 0, unknown: 0 } } };
  const record = stateToFleetRecord({}, fleetStateFromObjects(instance, counts, { today: { cost: 0 }, sevenDay: { cost: 0 } }, { rows: [row] }));
  for (const key of ['model', 'effort', 'context_pct', 'new_session_threshold']) assert.equal(Object.hasOwn(record, key), false);
  assert.equal(record.activity, null);
});

// The object API exposes installed-version updates only. This pure projection
// uses no services, sockets, timers or external requests.
test('Fleet upgrade marker uses only installed-version update fields', () => {
  for (const field of ['zylos_update', 'cc_update', 'codex_update']) {
    assert.equal(stateToFleetRecord({}, { runtime_info: { [field]: '2.0.0' } }).has_upgrade, true, field);
  }
  const runtimeInfo = {};
  for (const field of ['cc_restart', 'codex_restart', 'pending_restart']) {
    Object.defineProperty(runtimeInfo, field, { get() { assert.fail(`retired restart observation read: ${field}`); } });
  }
  assert.equal(stateToFleetRecord({}, { runtime_info: runtimeInfo }).has_upgrade, false);
});

test('Fleet placeholder and failed records omit Origin child fields', () => {
  const first = { name: 'first', base_url: 'https://first.example.test' };
  const poller = new FleetPoller(makeConfig([first]), { now: () => 0 });
  const check = () => {
    for (const record of poller.getFleet().agents) {
      assert.equal(Object.hasOwn(record, 'has_subagent'), false);
      assert.equal(Object.hasOwn(record, 'subagent_count'), false);
    }
  };
  check();
  const second = { name: 'second', base_url: 'https://second.example.test' };
  poller.addAgent(second);
  check();
  for (const reason of ['unreachable', 'version_unsupported']) {
    poller._setFailure(first, reason);
    check();
  }
});
