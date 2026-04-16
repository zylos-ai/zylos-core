import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getClaudePid,
  readParentPidFromProc,
  readParentPidViaPs
} from '../claude-pid.js';

describe('claude-pid', () => {
  it('reads Claude pid from /proc parent status on linux', () => {
    const pid = readParentPidFromProc(222, {
      fsImpl: {
        readFileSync(filePath) {
          assert.equal(filePath, '/proc/222/status');
          return 'Name:\tbash\nPPid:\t111\n';
        }
      }
    });
    assert.equal(pid, 111);
  });

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

  it('uses ps as linux fallback when /proc is unavailable', () => {
    const pid = getClaudePid({
      platform: 'linux',
      shellPid: 333,
      fsImpl: {
        readFileSync() {
          throw new Error('missing procfs');
        }
      },
      execFileSyncImpl() {
        return '222\n';
      }
    });
    assert.equal(pid, 222);
  });

  it('returns the shell pid when no parent lookup succeeds', () => {
    const pid = getClaudePid({
      platform: 'darwin',
      shellPid: 444,
      execFileSyncImpl() {
        throw new Error('ps failed');
      }
    });
    assert.equal(pid, 444);
  });

  it('reads parent pid via ps helper', () => {
    const pid = readParentPidViaPs(555, {
      execFileSyncImpl() {
        return '777\n';
      }
    });
    assert.equal(pid, 777);
  });
});
