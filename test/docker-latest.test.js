import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isLatestStableTag } from '../scripts/docker-latest.js';

const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

describe('latest stable version selection', () => {
  for (const [name, current, tags, expected] of [
    ['stable patch', 'v0.9.4', ['v0.9.3', 'v0.9.4'], true],
    ['beta', 'v1.0.0-beta.1', ['v0.9.4', 'v1.0.0-beta.1'], false],
    ['release candidate', 'v1.0.0-rc.2', ['v1.0.0-rc.2'], false],
    ['older release line', 'v0.9.5', ['v0.9.5', 'v1.0.0'], false],
    ['next stable patch', 'v1.0.1', ['v1.0.0', 'v1.0.1', 'v2.0.0-beta.1'], true],
    ['unrelated tags', 'v0.9.4', ['issue-520-assets', 'v0.9.4', 'v99.0', '1.0.0'], true],
    ['numeric minor order', 'v1.9.9', ['v1.10.0', 'v1.9.9'], false],
    ['numeric patch order', 'v1.0.10', ['v1.0.9', 'v1.0.10'], true],
    ['large numeric components', 'v9007199254740992.0.0', ['v9007199254740992.0.0', 'v9007199254740993.0.0'], false],
    ['build metadata tie', 'v1.0.0+linux.01', ['v1.0.0+linux.01', 'v1.0.0+other', 'v1.0.0'], true],
    ['higher stable with metadata', 'v1.0.0', ['v1.0.0', 'v1.0.1+build'], false],
    ['empty list', 'v1.0.0', [], false],
    ['current tag absent', 'v1.0.0', ['v0.9.4'], false],
    ...['1.0.0', 'v1.0', 'v01.0.0', 'v1.0.0-beta.01', 'v1.0.0+', 'v1.0.0\n'].map(tag =>
      ['invalid current ' + JSON.stringify(tag), tag, [tag], false]),
  ]) {
    test(name, () => {
      assert.equal(isLatestStableTag(current, tags), expected);
    });
  }
});

// Covers the real CLI/git/output boundary. Run when the script or workflow wiring
// changes; skip for documentation-only edits. Every case uses fake git, no network,
// private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/cwd and no inherited credentials/config.
// tmux and databases are not exercised. afterEach removes only this case's fixture.
