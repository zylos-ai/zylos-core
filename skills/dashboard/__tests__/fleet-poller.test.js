import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { agentColor } from '../public/js/agent-color.js';
import { FleetPoller, stateToFleetRecord } from '../src/lib/fleet-poller.js';
import { objectResponse } from './fixtures/fleet-object-api.js';
import { assertFleetPayloadSafe, buildSafeFleetPayload } from '../src/lib/fleet-payload.js';

const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});

test('buildSafeFleetPayload redacts string-leaf leaks for shared HTTP and SSE payloads', () => {
  const self = stateToFleetRecord({ name: 'local', color: agentColor('local') }, { state: 'IDLE' }, { self: true, nowMs: 0 });
  const result = buildSafeFleetPayload({
    selfRecord: self,
    remoteFleet: {
      agents: [{
        name: 'remote',
        base_url: 'mentions zylos_ak_ prefix and masked zylos_st_...abcd',
        self: false
      }]
    },
    nowIso: '2026-06-09T00:00:00.000Z'
  });

  assert.equal(result.redacted, true);
  assert.equal(result.payload.agents[1].base_url, 'mentions [redacted] prefix and masked [redacted]');
  assert.doesNotThrow(() => assertFleetPayloadSafe(result.payload));
});

// --- Fleet identity color and rate limits ---

// Injected transport and clock: no listener, real fetch, probe loop or subprocess.
// Run for latency sampling/serialization changes; skip unrelated fleet settings.

// The adapter consumes the public compact list, even if a caller accidentally
// retains a raw observation alongside it. Accessors make regressions observable.

// A remote may be an older Dashboard (null = unreadable) or a newer one
// ('unreadable'); both are an unknown mode, never a bad payload. A newer
// instance without a mode key reports its effective single mode.

// The object API exposes installed-version updates only. This pure projection
// uses no services, sockets, timers or external requests.

test('Fleet polls carry avatar versions from the peer instance identity', async () => {
  const versions = [undefined, 'a'.repeat(64), 'b'.repeat(64)];
  let version;
  const poller = new FleetPoller({
    fleet: { agents: [{ name: 'remote-alias', base_url: 'https://remote.example.test', read_api_key: 'fixture-key' }] }
  }, {
    now: () => 1000,
    fetch: async (url) => url.endsWith('/api/auth/token')
      ? Response.json({ token: 'fixture-token', ttl_seconds: 3600 })
      : objectResponse(url, { instance: { agent: { name: 'peer', avatar_version: version } } })
  });

  for (version of versions) {
    await poller.pollOnce();
    const [record] = poller.getFleet().agents;
    assert.equal(record.name, 'remote-alias');
    assert.equal(record.health_reason, 'idle');
    assert.equal(record.avatar_version, version ?? null);
  }
});
