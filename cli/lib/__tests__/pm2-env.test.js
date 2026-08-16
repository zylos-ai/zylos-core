import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildManagedPath, buildManagedPm2Env } from '../pm2-env.js';

describe('PM2 managed environment', () => {
  it('places SYSTEM_PATH before the ambient PATH and deduplicates entries', () => {
    assert.equal(
      buildManagedPath({
        systemPath: '/nvm/bin:/opt/homebrew/bin',
        envPath: '/opt/homebrew/bin:/usr/bin',
      }),
      '/nvm/bin:/opt/homebrew/bin:/usr/bin'
    );
  });

  it('returns a process environment with the managed PATH', () => {
    const env = buildManagedPm2Env({
      PATH: '/opt/homebrew/bin:/usr/bin',
      SYSTEM_PATH: '/nvm/bin:/opt/homebrew/bin',
      KEEP_ME: 'yes',
    });

    assert.equal(env.PATH, '/nvm/bin:/opt/homebrew/bin:/usr/bin');
    assert.equal(env.KEEP_ME, 'yes');
  });
});
