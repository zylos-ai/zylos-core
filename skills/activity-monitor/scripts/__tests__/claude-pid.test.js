import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getClaudePid,
  } from '../claude-pid.js';

describe('claude-pid', () => {

  it('falls back to ps parent lookup on darwin', () => {
    const pid = getClaudePid({
      platform: 'darwin',
      shellPid: 222,
      execFileSyncImpl(command, args) {
        assert.equal(command, 'ps');
        assert.deepEqual(args, ['-o', 'ppid=', '-p', '222']);
        return ' 111\n';
      }
    });
    assert.equal(pid, 111);
  });

});

describe('hook trigger process', () => {

  // An `exec node ...` hook has the runtime itself as its parent, so the
  // runtime's own parent (the tmux server) must not be returned.
  it('getClaudePid names the runtime that fired an exec-form hook, not its shell or the tmux server', () => {
    const stat = (pid, comm, ppid, start) => `${pid} (${comm}) S ${ppid} ${Array(17).fill('0').join(' ')} ${start} 0`;
    const proc = {
      '/proc/50/stat': stat(50, 'tmux: server', 1, '500'),
      '/proc/50/status': 'Name:\ttmux: server\nPPid:\t1\n',
      '/proc/100/stat': stat(100, 'claude', 50, '1000'),
      '/proc/100/status': 'Name:\tclaude\nPPid:\t50\n',
      '/proc/200/stat': stat(200, 'sh', 100, '2000'),
      '/proc/200/status': 'Name:\tsh\nPPid:\t100\n',
    };
    const fsImpl = { readFileSync(file) { if (file in proc) return proc[file]; throw new Error(`ENOENT ${file}`); } };
    const execFileSyncImpl = () => { throw new Error('ps must not be needed'); };
    assert.equal(getClaudePid({ platform: 'linux', shellPid: 100, fsImpl, execFileSyncImpl }), 100, 'hook parent is the runtime');
    assert.equal(getClaudePid({ platform: 'linux', shellPid: 200, fsImpl, execFileSyncImpl }), 100, 'a shell sits in between');
  });

});
