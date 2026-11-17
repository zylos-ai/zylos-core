import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPm2LaunchAgentPlist,
  buildPm2LaunchdResurrectScript,
} from '../../commands/init.js';

test('macOS PM2 resurrect script uses explicit env and non-reserved status variable', () => {
  const script = buildPm2LaunchdResurrectScript({
    home: '/Users/alice',
    zylosDir: '/Users/alice/zylos',
    pm2Path: '/Users/alice/.nvm/versions/node/v24.14.0/bin/pm2',
    pathEnv: '/custom/bin:/usr/bin:/bin',
  });

  assert.match(script, /export HOME="\/Users\/alice"/);
  assert.match(script, /export PM2_HOME="\/Users\/alice\/\.pm2"/);
  assert.match(script, /PM2_BIN="\/Users\/alice\/\.nvm\/versions\/node\/v24\.14\.0\/bin\/pm2"/);
  assert.match(script, /"\$\{PM2_BIN\}" resurrect/);
  assert.match(script, /resurrect_status=\$\?/);
  assert.doesNotMatch(script, /\nstatus=\$\?/);
});

test('macOS PM2 LaunchAgent plist points at wrapper with PM2 environment', () => {
  const plist = buildPm2LaunchAgentPlist({
    label: 'com.zylos.pm2.alice',
    scriptPath: '/Users/alice/zylos/bin/zylos-pm2-resurrect',
    home: '/Users/alice',
    pathEnv: '/custom/bin:/usr/bin:/bin',
    zylosDir: '/Users/alice/zylos',
  });

  assert.match(plist, /<string>com\.zylos\.pm2\.alice<\/string>/);
  assert.match(plist, /<string>\/Users\/alice\/zylos\/bin\/zylos-pm2-resurrect<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>PM2_HOME<\/key>\s*<string>\/Users\/alice\/\.pm2<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/custom\/bin:\/usr\/bin:\/bin<\/string>/);
});

test('macOS PM2 LaunchAgent plist escapes XML-sensitive values', () => {
  const plist = buildPm2LaunchAgentPlist({
    label: 'com.zylos.pm2.a&b',
    scriptPath: '/Users/a&b/zylos/bin/zylos-pm2-resurrect',
    home: '/Users/a&b',
    pathEnv: '/custom<&>:/usr/bin',
    zylosDir: '/Users/a&b/zylos',
  });

  assert.match(plist, /com\.zylos\.pm2\.a&amp;b/);
  assert.match(plist, /\/Users\/a&amp;b\/zylos\/bin\/zylos-pm2-resurrect/);
  assert.match(plist, /\/custom&lt;&amp;&gt;:\/usr\/bin/);
});
