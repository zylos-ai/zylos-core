import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { publishBootstrapReady } from '../bootstrap-ready.js';
import { enqueueStartupPrompt } from '../session-start-prompt.js';
import { routerFixture } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';

// Publication/consumer integration: actual startup producer, atomic READY write
// and Router adoption, with fixture identities and in-memory C4. Run for startup
// outcome propagation; unrelated UI may skip. Root runner isolates all home,
// instance, PM2, temp and socket paths before imports. No terminal/service starts;
// t tears down the router, database and private READY directory.
for (const outcome of ['skipped', 'failed', 'legacy']) {
  test(`startup ${outcome} outcome has the corresponding adoption diagnostic once`, async t => {
    const f = routerFixture(t); f.put('origin'); const live = f.put('a');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-result-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const record = await publishBootstrapReady({ source: 'startup', session_id: live.sessionId }, {
      env: { ZYLOS_RUN_ID: live.runId }, scopeReader: async () => ({ dir }), identityReader: async () => ({}), now: f.now,
      enqueue: outcome === 'skipped'
        ? source => enqueueStartupPrompt(source, { onboardingPending: () => true, execFile: () => assert.fail('skip must not enqueue') })
        : async () => { throw new Error('private fixture queue unavailable'); },
    });
    if (outcome === 'legacy') delete record.startupPrompt;
    f.current.set('a', record);
    const router = f.create(); await router.initialize(); await f.rounds(3);
    const events = f.events.filter(row => row.session_group === 'a' && row.event.startsWith('startup_prompt_'));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, outcome === 'skipped' ? 'startup_prompt_skipped' : 'startup_prompt_missing');
    assert.equal(events[0].reason, outcome === 'skipped' ? 'onboarding_pending' : outcome === 'failed' ? 'enqueue_failed' : 'unknown');
    assert.equal(record.startupControlIds.length, 0);
  });
}
