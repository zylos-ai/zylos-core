import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { recordedSource } from '../components.js';

const SHA1 = '0123456789abcdef0123456789abcdef01234567';
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});




describe('recordedSource describes the code an install or upgrade put on the machine', () => {

  it('keeps a local source as it is and adds the commit its archive names', () => {
    assert.deepEqual(
      recordedSource({ type: 'local-tarball', path: '/srv/x.tar.gz' }, { commit: SHA1 }),
      { type: 'local-tarball', path: '/srv/x.tar.gz', commit: SHA1 },
    );
    assert.deepEqual(
      recordedSource({ type: 'local-dir', path: '/srv/x' }, { success: true, extractedDir: '/srv/x' }),
      { type: 'local-dir', path: '/srv/x', commit: null },
    );
  });
});
