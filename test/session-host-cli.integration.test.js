import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPrivateFixture, runPrivateFixture } from './helpers/private-instance-fixture.js';

// Runs the real CLI, C4 receive and owner alert transport against isolated
// channels and one private C4 database. Run for hosting CLI, notifications,
// schema or routing changes. Skip unrelated UI and runtime transport work.
// The launcher proves private paths and reaps the worker's process group.
test('session hosting applies immediately and follows the owner alert routing and mute rules', { timeout: 45_000 }, async t => {
  const fixture = createPrivateFixture(t);
  await runPrivateFixture(fixture, fileURLToPath(new URL('./fixtures/session-host-cli.js', import.meta.url)),
    [], { timeout: 40_000 });
});
