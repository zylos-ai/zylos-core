import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

const {
  buildPolicy,
  evaluateCommand,
  evaluateHookInput,
  tokenizeShell,
} = await import('../codex-path-guard.js');

const env = {
  HOME: '/home/user',
  ZYLOS_DIR: '/home/user/zylos',
  TMPDIR: '/tmp',
};

function policy(cwd = '/home/user/zylos') {
  return buildPolicy({ cwd, env });
}

describe('codex path guard', () => {
  it('allows read-only shell commands outside the write allowlist', () => {
    const result = evaluateCommand('ls /etc', policy());
    assert.equal(result.allow, true);
  });

  it('allows writes inside the session cwd', () => {
    const result = evaluateCommand('mkdir -p docs/security && touch docs/security/notes.md', policy());
    assert.equal(result.allow, true);
  });

  it('blocks writes outside the session cwd and temp roots', () => {
    const result = evaluateCommand('tee /etc/zylos.conf', policy());
    assert.equal(result.allow, false);
    assert.match(result.reason, /outside Codex write allowlist/);
  });

  it('does not strip equals signs from ordinary path arguments', () => {
    const result = evaluateCommand('touch /etc/zylos=blocked', policy());
    assert.equal(result.allow, false);
  });

  it('checks dd output targets expressed as of=...', () => {
    const result = evaluateCommand('dd if=/tmp/source of=/etc/zylos.conf', policy());
    assert.equal(result.allow, false);
  });

  it('blocks home-directory deletion even when expressed with tilde', () => {
    const result = evaluateCommand('rm -rf ~/', policy());
    assert.equal(result.allow, false);
  });

  it('blocks Zylos workspace deletion from the repo root', () => {
    const result = evaluateCommand('rm -rf workspace', policy('/home/user/zylos'));
    assert.equal(result.allow, false);
  });

  it('allows configured additional write roots', () => {
    const customPolicy = buildPolicy({
      cwd: '/home/user/zylos',
      env: {
        ...env,
        ZYLOS_CODEX_RWX_ALLOWLIST: `/srv/build${path.delimiter}/var/tmp/zylos`,
      },
    });

    const result = evaluateCommand('mkdir -p /srv/build/output', customPolicy);
    assert.equal(result.allow, true);
  });

  it('blocks destructive git operations', () => {
    const result = evaluateCommand('git reset --hard HEAD', policy());
    assert.equal(result.allow, false);
    assert.match(result.reason, /git operation/);
  });

  it('detects mutating commands behind env wrappers and assignments', () => {
    const envWrapper = evaluateCommand('env FOO=bar rm -rf ~/zylos/workspace', policy());
    const inlineAssignment = evaluateCommand('FOO=bar touch ../outside.md', policy());

    assert.equal(envWrapper.allow, false);
    assert.equal(inlineAssignment.allow, false);
  });

  it('evaluates Codex hook JSON input', () => {
    const result = evaluateHookInput({
      cwd: '/home/user/zylos',
      tool_input: { command: 'cp README.md /tmp/README.md' },
    }, env);

    assert.equal(result.allow, true);
  });

  it('tokenizes quoted paths as a single target', () => {
    assert.deepEqual(
      tokenizeShell('rm -rf "workspace/co agent"'),
      ['rm', '-rf', 'workspace/co agent']
    );
  });
});
