import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  firstNonShellAncestor,
  getClaudePid,
  parseProcStat,
  parsePsRow,
  readHookTrigger,
  readParentPidFromProc,
  readParentPidViaPs,
  readProcessInfo
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

describe('hook trigger process', () => {
  it('parses a /proc stat line whose name holds spaces and parentheses', () => {
    const fields = ['S', '77', ...Array(17).fill('0'), '123456', '0'];
    assert.deepEqual(parseProcStat(5, `5 (a (b) c) ${fields.join(' ')}`), { pid: 5, ppid: 77, start: '123456', comm: 'a (b) c' });
    assert.equal(parseProcStat(5, '5 no-name S 1'), null);
  });

  it('parses a ps row with its five-token start time', () => {
    assert.deepEqual(parsePsRow(9, '  412 Tue Nov 17 09:01:02 2026 /usr/local/bin/claude\n'),
      { pid: 9, ppid: 412, start: 'Tue Nov 17 09:01:02 2026', comm: 'claude' });
    assert.equal(parsePsRow(9, '412\n'), null);
  });

  it('reads this process from /proc and through ps', () => {
    const own = readProcessInfo(process.pid);
    assert.equal(own.pid, process.pid);
    assert.equal(own.ppid, process.ppid);
    assert.match(own.start, /^\d+$/);
    const viaPs = readProcessInfo(process.pid, { platform: 'darwin' });
    assert.equal(viaPs?.ppid, process.ppid);
    assert.equal(readProcessInfo(0), null);
  });

  it('skips shells between the hook and the runtime that fired it', () => {
    const tree = {
      3: { pid: 3, ppid: 2, start: '3', comm: 'sh' },
      2: { pid: 2, ppid: 1, start: '2', comm: '-bash' },
      1: { pid: 1, ppid: 0, start: '1', comm: 'claude' },
    };
    assert.equal(firstNonShellAncestor(3, pid => tree[pid] ?? null)?.pid, 1);
    assert.equal(firstNonShellAncestor(3, pid => (pid === 3 ? tree[3] : null)), null);
    const shells = pid => ({ pid, ppid: pid + 1, start: '1', comm: 'sh' });
    assert.equal(firstNonShellAncestor(1, shells), null, 'the walk is bounded');
  });

  it('names the process that ran a real shell command', () => {
    const probe = "import('" + new URL('../claude-pid.js', import.meta.url).href + "').then(m=>process.stdout.write(JSON.stringify(m.readHookTrigger())))";
    for (const command of [`exec "${process.execPath}" -e "${probe}"`, `"${process.execPath}" -e "${probe}"; true`]) {
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).pid, process.pid, command);
    }
    assert.equal(readHookTrigger({ startPid: process.pid }).pid, process.pid);
  });

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

  it('getClaudePid names the process that ran a real exec-form or shell hook command', () => {
    const probe = "import('" + new URL('../claude-pid.js', import.meta.url).href + "').then(m=>process.stdout.write(String(m.getClaudePid())))";
    for (const command of [`exec "${process.execPath}" -e "${probe}"`, `"${process.execPath}" -e "${probe}"; true`]) {
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(Number(result.stdout), process.pid, command);
    }
  });
});
