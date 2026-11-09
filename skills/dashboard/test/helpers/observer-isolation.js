import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function assertObserverTestIsolation() {
  const home = fs.realpathSync(process.env.HOME);
  const ownerHome = fs.realpathSync(os.userInfo().homedir);
  assert.ok(!home.startsWith(ownerHome + path.sep));
  assert.notEqual(home, ownerHome);
  const root = path.dirname(home);
  for (const key of ['ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]?.startsWith(root + path.sep), `${key} is private`);
  }
  const tmp = fs.realpathSync(process.env.TMPDIR);
  assert.ok(Buffer.byteLength(path.join(tmp, `zobs-${process.getuid()}`, 'zobs2-0123456789abcdef', 'observer-0123456789abcdef')) < 104,
    'runner TMPDIR permits a complete private session socket');
  console.log('Observer test isolation:', JSON.stringify({ HOME: home, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: tmp, nativeCommands: 'no native tmux/Zellij; fixture functions and local tar/shell only',
    network: 'injected fetch; no external network', database: 'none' }));
}
