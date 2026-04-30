import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageRouter, messageForRoute, normalizeHealth } from '../message-router.js';

async function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-router-'));
  try {
    return await fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function createHealthEngine(overrides = {}) {
  return {
    health: 'ok',
    healthReason: '',
    lastRecoveryAt: 0,
    getBackoffDelay: () => 0,
    notifyUserMessage: () => false,
    runRecoveryProbe: async () => ({ recovered: false }),
    ...overrides,
  };
}

function routeRequest(overrides = {}) {
  return {
    version: 1,
    type: 'route',
    requestId: 'req-1',
    channel: 'lark',
    endpoint: 'ep1',
    noReply: false,
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe('messageForRoute', () => {
  it('maps reason prefixes and health fallbacks', () => {
    assert.match(messageForRoute({ health: 'unavailable', reason: 'tool_timeout_exec' }), /工具执行卡住/);
    assert.match(messageForRoute({ health: 'unavailable', reason: 'sticky_context_restart' }), /上下文异常/);
    assert.match(messageForRoute({ health: 'rate_limited', reason: '' }), /限流/);
    assert.match(messageForRoute({ health: 'auth_failed', reason: '' }), /认证不可用/);
  });
});

describe('normalizeHealth', () => {
  it('keeps public health states and maps legacy unavailable states', () => {
    assert.equal(normalizeHealth('ok'), 'ok');
    assert.equal(normalizeHealth('rate_limited'), 'rate_limited');
    assert.equal(normalizeHealth('auth_failed'), 'auth_failed');
    assert.equal(normalizeHealth('recovering'), 'unavailable');
    assert.equal(normalizeHealth('down'), 'unavailable');
  });
});

describe('MessageRouter route', () => {
  it('returns recovered=true and clears stale cache when health is ok', async () => {
    await withTmpDir(async (tmpDir) => {
      const cacheFile = path.join(tmpDir, 'cache.json');
      fs.writeFileSync(cacheFile, JSON.stringify({ version: 1 }));
      const router = new MessageRouter({ healthEngine: createHealthEngine(), cacheFile });

      const decision = await router.route(routeRequest());

      assert.equal(decision.recovered, true);
      assert.equal(decision.health, 'ok');
      assert.equal(fs.existsSync(cacheFile), false);
    });
  });

  it('calls notifyUserMessage before cache lookup and probes when accelerated', async () => {
    let notifyCalls = 0;
    let probeCalls = 0;
    const engine = createHealthEngine({
      health: 'rate_limited',
      healthReason: 'rate_limit_detected',
      notifyUserMessage: () => {
        notifyCalls++;
        return true;
      },
      runRecoveryProbe: async () => {
        probeCalls++;
        return { recovered: false };
      },
    });
    const router = new MessageRouter({ healthEngine: engine });

    const decision = await router.route(routeRequest());

    assert.equal(notifyCalls, 1);
    assert.equal(probeCalls, 1);
    assert.equal(decision.recovered, false);
    assert.equal(decision.health, 'rate_limited');
    assert.match(decision.userMessage, /限流/);
  });

  it('returns cached negative decisions without probing', async () => {
    await withTmpDir(async (tmpDir) => {
      let probeCalls = 0;
      const cacheFile = path.join(tmpDir, 'cache.json');
      const now = 100000;
      fs.writeFileSync(cacheFile, JSON.stringify({
        version: 1,
        health: 'unavailable',
        reason: 'heartbeat_timeout',
        recovered: false,
        userMessage: 'cached message',
        createdAt: now - 1000,
        expiresAt: now + 1000,
        probeStartedAt: now - 1000,
      }));
      const router = new MessageRouter({
        cacheFile,
        now: () => now,
        healthEngine: createHealthEngine({
          health: 'recovering',
          healthReason: 'heartbeat_timeout',
          runRecoveryProbe: async () => {
            probeCalls++;
            return { recovered: false };
          },
        }),
      });

      const decision = await router.route(routeRequest());

      assert.equal(probeCalls, 0);
      assert.equal(decision.cacheHit, true);
      assert.equal(decision.userMessage, 'cached message');
    });
  });

  it('omits userMessage for unhealthy no-reply route decisions', async () => {
    const router = new MessageRouter({
      healthEngine: createHealthEngine({
        health: 'recovering',
        healthReason: 'heartbeat_timeout',
      }),
    });

    const decision = await router.route(routeRequest({ noReply: true }));

    assert.equal(decision.recovered, false);
    assert.equal(decision.health, 'unavailable');
    assert.equal(decision.userMessage, undefined);
  });

  it('joins concurrent probes for the same health and reason', async () => {
    let probeCalls = 0;
    let resolveProbe;
    const probe = new Promise(resolve => { resolveProbe = resolve; });
    const router = new MessageRouter({
      healthEngine: createHealthEngine({
        health: 'recovering',
        healthReason: 'heartbeat_timeout',
        notifyUserMessage: () => true,
        runRecoveryProbe: async () => {
          probeCalls++;
          return probe;
        },
      }),
    });

    const first = router.route(routeRequest({ requestId: 'req-1' }));
    const second = router.route(routeRequest({ requestId: 'req-2' }));
    resolveProbe({ recovered: false });
    const decisions = await Promise.all([first, second]);

    assert.equal(probeCalls, 1);
    assert.equal(decisions[0].recovered, false);
    assert.equal(decisions[1].recovered, false);
  });
});
