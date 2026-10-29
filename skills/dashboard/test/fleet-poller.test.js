import assert from 'node:assert/strict';
import test from 'node:test';
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
    return jsonResponse({
      state: 'BUSY',
      running_tools: [{ tool_name: 'Bash', tool_detail: 'npm test' }],
      runtime_info: { model: 'GPT-5', effort: 'high', zylos_update: '1.2.3' },
      new_session_threshold: 75,
      system_metrics: { cpu_pct: 12, mem_pct: 34, disk_pct: 56 },
      session_cost: 1.23,
      daily_cost: 4.56,
      weekly_cost: 7.89,
      active_subagents: [{ last_activity: 'Worker running' }],
      metrics: {
        context_pct: { value: 42 },
        session_cost: { value: 1.23 }
      }
    });
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
  assert.equal(fleet.agents[0].activity, 'npm test');
  assert.equal(fleet.agents[0].context_pct, 42);
  assert.equal(fleet.agents[0].cost, 1.23);
  assert.equal(fleet.agents[0].session_cost, 1.23);
  assert.equal(fleet.agents[0].daily_cost, 4.56);
  assert.equal(fleet.agents[0].weekly_cost, 7.89);
  assert.equal(fleet.agents[0].model, 'GPT-5');
  assert.equal(fleet.agents[0].effort, 'high');
  assert.equal(fleet.agents[0].new_session_threshold, 75);
  assert.equal(fleet.agents[0].cpu_pct, 12);
  assert.equal(fleet.agents[0].mem_pct, 34);
  assert.equal(fleet.agents[0].disk_pct, 56);
  assert.equal(fleet.agents[0].has_upgrade, true);
  assert.equal(fleet.agents[0].has_subagent, true);
  assert.equal(fleet.agents[0].health_reason, 'ok');
  assert.equal(JSON.stringify(fleet).includes('zylos_ak_secret'), false);
  assert.equal(JSON.stringify(fleet).includes('zylos_st_secret'), false);
  assert.equal(calls[0].authorization, 'Bearer zylos_ak_secret');
  assert.equal(fleet.agents[0].self, false, 'external records must not be flagged self');
});

test('fleet poller reports initial not-polled records without down link quality', () => {
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: async () => jsonResponse({ state: 'IDLE' }), now: () => 0 });

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
    return jsonResponse({ state: 'IDLE' });
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
    return jsonResponse({ state: 'IDLE' });
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
    return jsonResponse({ state: 'IDLE' });
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
    stateCount += 1;
    if (stateCount === 3) return jsonResponse({ error: 'expired' }, 401);
    return jsonResponse({ state: 'IDLE' });
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
    return jsonResponse({ state: 'IDLE' });
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
    return jsonResponse({ state: 'IDLE' });
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
    return jsonResponse({ state: 'IDLE' });
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
    return jsonResponse({ state: 'IDLE' });
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
    if (url.endsWith('/api/state')) {
      stateFetches += 1;
      return jsonResponse({ state: 'IDLE' });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ], { slow_threshold_ms: 50 }), { fetch: fetchImpl, now: () => now });
  const agent = poller.agents[0];
  poller._handleSseEvent(agent, { event: 'fleet_state', data: '{"state":"BUSY"}' });

  for (let i = 0; i < 5; i += 1) await poller._probeAgentLatency(agent);
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

test('fleet poller idle watchdog aborts half-open SSE and starts fallback polling (#180)', async () => {
  const timers = [];
  let sseController;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE' });
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
  assert.equal(record.model, null);
  assert.equal(record.effort, null);
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
  assert.equal(record.activity, 'npm test');
  assert.equal(record.context_pct, 42);
  assert.equal(record.cost, 1.23);
  assert.equal(record.session_cost, 1.23);
  assert.equal(record.daily_cost, 4.56);
  assert.equal(record.weekly_cost, 7.89);
  assert.equal(record.model, 'Opus 4.6');
  assert.equal(record.effort, 'high');
  assert.equal(record.new_session_threshold, 75);
  assert.equal(record.cpu_pct, 12);
  assert.equal(record.mem_pct, 34);
  assert.equal(record.disk_pct, 56);
  assert.equal(record.has_upgrade, true);
  assert.equal(record.has_subagent, true);
  assert.equal(record.base_url, null);
  assert.equal(record.pulse_rate, 1);
  assert.equal(record.health_reason, 'ok');
  assert.equal(record.last_seen, new Date(0).toISOString());
  assert.equal(JSON.stringify(record).includes('zylos_ak_'), false);
  assert.equal(JSON.stringify(record).includes('zylos_st_'), false);
});

test('stateToFleetRecord consumes API snake_case cost tiers directly (#174)', () => {
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
  assert.equal(record.session_cost, 1.23);
  assert.equal(record.daily_cost, 4.56);
  assert.equal(record.weekly_cost, 7.89);
});

test('stateToFleetRecord maps idle and self offline/unknown states', () => {
  const agent = { name: 'a', color: agentColor('a') };
  const idle = stateToFleetRecord(agent, { state: 'IDLE' }, { self: true, nowMs: 0 });
  assert.equal(idle.health_reason, 'idle');
  assert.equal(idle.pulse_rate, 1);

  const offline = stateToFleetRecord(agent, { state: 'OFFLINE' }, { self: true, nowMs: 0 });
  assert.equal(offline.health_reason, 'offline');
  assert.equal(offline.pulse_rate, 0);

  const unknown = stateToFleetRecord(agent, { state: 'UNKNOWN' }, { self: true, nowMs: 0 });
  assert.equal(unknown.health_reason, 'offline');
  assert.equal(unknown.pulse_rate, 0);
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
  parser.push(': keepalive\r\nid: 7\r\nevent: fleet_state\r\ndata: {"state":"BUSY"');
  parser.push('\r\ndata: ,"context_pct":42}\r\n\r\n');
  parser.push('event: fleet_state\rdata: {"state":"IDLE"}\r\r');
  parser.flush();
  assert.deepEqual(events, [
    {
      event: 'fleet_state',
      data: '{"state":"BUSY"\n,"context_pct":42}',
      id: '7'
    },
    {
      event: 'fleet_state',
      data: '{"state":"IDLE"}',
      id: null
    }
  ]);
});

test('SseEventParser preserves event type when CRLF splits across chunks', () => {
  const events = [];
  const parser = new SseEventParser((event) => events.push(event));
  parser.push('event: fleet_state\r');
  parser.push('\ndata: {"state":"BUSY"}\r\n\r\n');
  parser.flush();
  assert.deepEqual(events, [{
    event: 'fleet_state',
    data: '{"state":"BUSY"}',
    id: null
  }]);
});

test('fleet poller SSE uses Bearer auth and fleet_state updates records', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.Authorization });
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE', context_pct: 1 });
    if (url.endsWith('/api/stream')) {
      assert.equal(options.headers.Authorization, 'Bearer zylos_st_stream');
      assert.equal(url.includes('token='), false);
      return streamResponse('event: fleet_state\ndata: {"state":"BUSY","context_pct":55,"session_cost":0.75}\n\n');
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  await poller._runSse(poller.agents[0], poller._streamState(poller.agents[0]), new AbortController().signal).catch(() => {});
  const record = poller.getFleet().agents[0];
  assert.equal(record.state, 'BUSY');
  assert.equal(record.context_pct, 55);
  assert.equal(record.session_cost, 0.75);
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
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE' });
    if (url.endsWith('/api/stream')) {
      streamCount += 1;
      return streamResponse(streamCount === 1
        ? 'event: auth_expired\ndata: {}\n\n'
        : 'event: fleet_state\ndata: {"state":"BUSY"}\n\n');
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
  assert.equal(tokenCount, 2);
  assert.equal(poller.getFleet().agents[0].state, 'BUSY');
});

test('fleet poller stop aborts active SSE fetch streams', async () => {
  let signal;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE' });
    if (url.endsWith('/api/stream')) {
      signal = options.signal;
      return new Promise(() => {});
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const poller = new FleetPoller(makeConfig([
    { name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' }
  ]), { fetch: fetchImpl, now: () => 0 });

  poller.start();
  await new Promise(resolve => setTimeout(resolve, 10));
  poller.stop();
  assert.equal(signal.aborted, true);
});

test('fleet poller SSE connect timeout clears connecting and starts recovery loops', async () => {
  const timers = [];
  const warnings = [];
  const logs = [];
  let streamSignal;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE' });
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

test('fleet poller resumes fallback polling when SSE has no fleet_state and stops after recovery', async () => {
  const timers = [];
  const cleared = new Set();
  let stateFetches = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_stream', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) {
      stateFetches += 1;
      return jsonResponse({ state: 'IDLE', context_pct: stateFetches });
    }
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
  poller.running = true;
  const stream = poller._streamState(agent);
  const run = poller._runSse(agent, stream, new AbortController().signal).catch(err => err);
  await new Promise(resolve => setTimeout(resolve, 0));
  const compatibilityTimer = timers.find(timer => timer.ms === poller.pollIntervalMs);
  assert.ok(compatibilityTimer, 'compatibility timer should be scheduled');

  compatibilityTimer.fn();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(stream.pollTimer, 'compatibility fallback should start polling');

  poller._handleSseEvent(agent, { event: 'fleet_state', data: '{"state":"BUSY"}' });
  assert.equal(stream.pollTimer, null);
  assert.ok(cleared.has(compatibilityTimer));
  poller.running = false;
  await run;
});

test('fleet poller watchdog revives dead records and wedged connecting state', () => {
  let now = 0;
  const timers = [];
  const warnings = [];
  const logs = [];
  const poller = new FleetPoller(makeConfig([
    { name: 'Dead', base_url: 'https://dead.example.test', read_api_key: 'zylos_ak_secret' },
    { name: 'Wedged', base_url: 'https://wedged.example.test', read_api_key: 'zylos_ak_secret' }
  ], { poll_interval_ms: 100, timeout_ms: 50, sse_reconnect_max_ms: 100 }), {
    fetch: async () => jsonResponse({ state: 'IDLE' }),
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

test('fleet poller watchdog no-ops for active, recovering, and fresh records', () => {
  let now = 0;
  const timers = [];
  const poller = new FleetPoller(makeConfig([
    { name: 'Reading', base_url: 'https://reading.example.test', read_api_key: 'zylos_ak_secret' },
    { name: 'Recovering', base_url: 'https://recovering.example.test', read_api_key: 'zylos_ak_secret' },
    { name: 'Fresh', base_url: 'https://fresh.example.test', read_api_key: 'zylos_ak_secret' }
  ], { poll_interval_ms: 100 }), {
    fetch: async () => jsonResponse({ state: 'IDLE' }),
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; }
  });
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

test('fleet poller self-heal watchdog timer is stopped cleanly', () => {
  const timers = [];
  const poller = new FleetPoller(makeConfig([], { poll_interval_ms: 100 }), {
    fetch: async () => jsonResponse({ state: 'IDLE' }),
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; }
  });

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
    return jsonResponse({ state: 'IDLE' });
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

test('fleet poller first add from empty fleet starts live polling and streaming', async () => {
  const calls = [];
  let streamSignal = null;
  const fetchImpl = async (url, options = {}) => {
    calls.push(url);
    if (url.endsWith('/api/auth/token')) {
      return jsonResponse({ token: 'zylos_st_added', expires_at: new Date(120000).toISOString(), scope: 'read' });
    }
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE', context_pct: 12 });
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

  poller.start();
  assert.equal(poller.running, true);
  assert.equal(poller.getFleet().count, 0);
  poller.addAgent({ name: 'Remote', base_url: 'https://remote.example.test', read_api_key: 'zylos_ak_secret' });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(poller.running, true);
  assert.equal(poller.getFleet().agents[0].name, 'Remote');
  assert.equal(poller.getFleet().agents[0].context_pct, 12);
  assert.ok(calls.some(url => url.endsWith('/api/state')));
  assert.ok(calls.some(url => url.endsWith('/api/stream')));
  assert.ok(streamSignal, 'SSE stream should be opened for the first added agent');
  assert.equal(pushedFleet.agents.some(a => a.name === 'Remote'), true);
  poller.stop();
});

test('fleet poller remove prevents late SSE failures and stale reconnect timers from resurrecting agents', async () => {
  const timers = [];
  let rejectStream;
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/api/auth/token')) {
      tokenCalls += 1;
      return jsonResponse({ token: 'zylos_st_removed', expires_at: new Date(120000).toISOString() });
    }
    if (url.endsWith('/api/state')) return jsonResponse({ state: 'IDLE' });
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

test('fleet poller reads top-level context_pct when metrics object is absent (#171)', async () => {
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
  assert.equal(record.context_pct, 63.5);
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

test('stateToFleetRecord derives activity_feed from running tools', () => {
  const record = stateToFleetRecord({ name: 'a' }, {
    state: 'BUSY',
    running_tools: [
      { tool_name: 'Bash', tool_detail: 'npm test', started_at: '2026-06-10T00:00:00Z' },
      { tool_name: 'Read', tool_detail: 'foo.js', started_at: '2026-06-10T00:00:05Z' }
    ]
  }, { self: false, nowMs: 0 });

  assert.equal(record.activity_feed.length, 2);
  assert.deepEqual(record.activity_feed[0], {
    kind: 'tool', label: 'Bash: npm test', started_at: '2026-06-10T00:00:00Z'
  });
  assert.deepEqual(record.activity_feed[1], {
    kind: 'tool', label: 'Read: foo.js', started_at: '2026-06-10T00:00:05Z'
  });
});

test('stateToFleetRecord activity_feed shows thinking when busy without tools, empty when idle', () => {
  const busy = stateToFleetRecord({ name: 'a' }, { state: 'BUSY', running_tools: [] }, { self: false, nowMs: 0 });
  assert.deepEqual(busy.activity_feed, [{ kind: 'thinking', label: null, started_at: null }]);

  const idle = stateToFleetRecord({ name: 'a' }, { state: 'IDLE' }, { self: false, nowMs: 0 });
  assert.deepEqual(idle.activity_feed, []);
});

test('stateToFleetRecord passes rate limit percentages through, defaulting to null', () => {
  const withRates = stateToFleetRecord({ name: 'a' }, {
    state: 'IDLE', rate_limit_pct: 13, rate_limit_7d_pct: 9
  }, { self: false, nowMs: 0 });
  assert.equal(withRates.rate_limit_pct, 13);
  assert.equal(withRates.rate_limit_7d_pct, 9);

  const without = stateToFleetRecord({ name: 'a' }, { state: 'IDLE' }, { self: false, nowMs: 0 });
  assert.equal(without.rate_limit_pct, null);
  assert.equal(without.rate_limit_7d_pct, null);
});

test('stateToFleetRecord idle activity prefers last assistant message over stale prompt', () => {
  const record = stateToFleetRecord({ name: 'a' }, {
    state: 'IDLE',
    last_prompt: { source: 'hxa-connect (zylos01)', summary: 'Prompt from hxa-connect (zylos01)', timestamp: '2026-06-10T09:00:00.000Z' },
    last_message: { text: 'Reviewed PR #186, conclusion CLEAN.', timestamp: '2026-06-10T09:01:00.000Z' }
  }, { self: false, nowMs: 0 });
  assert.equal(record.activity, 'Reviewed PR #186, conclusion CLEAN.');
});

test('stateToFleetRecord falls back to prompt summary while the turn is still open', () => {
  // The producer clears last_message on user_prompt_submit, so an open turn
  // has only the prompt summary — mirroring the single-agent transient line.
  const record = stateToFleetRecord({ name: 'a' }, {
    state: 'BUSY',
    last_prompt: { summary: 'Prompt from lark', timestamp: '2026-06-10T09:00:00.000Z' },
    last_message: null
  }, { self: false, nowMs: 0 });
  assert.equal(record.activity, 'Prompt from lark');
});

test('stateToFleetRecord accepts legacy string-form last_message', () => {
  const record = stateToFleetRecord({ name: 'a' }, {
    state: 'IDLE',
    last_prompt: { summary: 'Prompt from lark' },
    last_message: 'plain text reply'
  }, { self: false, nowMs: 0 });
  assert.equal(record.activity, 'plain text reply');
});
