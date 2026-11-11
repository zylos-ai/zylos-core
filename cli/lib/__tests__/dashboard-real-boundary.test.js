import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateFixture, runPrivateFixture, stopPrivateTmux } from '../../../test/helpers/private-instance-fixture.js';

// Integration boundary: the real Core reader, control CLI and private tmux/Sock.
// Run for Core/Origin/status boundary
// changes; skip unrelated CLI changes. HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and
// private socket/DB targets are checked before the child imports product config.
// The bounded child owns its Sock server; timeout cleanup stops private tmux.
test('real Core reader, targeted control CLI and Sock retain Origin boundaries', { timeout: 35000 }, async t => {
  const sharedSkills = path.join(process.env.ZYLOS_DIR, '.claude/skills');
  assert.equal(fs.existsSync(sharedSkills), false, 'shared runner skills directory is clean before the dashboard fixture');
  const scope = createPrivateFixture(t);
  try {
    await runPrivateFixture(scope, fileURLToPath(new URL('../../../test/fixtures/dashboard-real-boundary-fixture.js', import.meta.url)), [], { nodeTest: true, timeout: 30000 });
  } finally {
    stopPrivateTmux(scope);
    scope.remove();
  }
  // This is before the outer safety cleanup: omitting the owned-scope cleanup
  // leaves the installed skill link/config behind and fails this assertion.
  assert.equal(fs.existsSync(scope.root), false, 'dashboard boundary fixture directory is clean');
  assert.equal(fs.existsSync(sharedSkills), false, 'shared runner skills directory is clean after the dashboard fixture');
});
