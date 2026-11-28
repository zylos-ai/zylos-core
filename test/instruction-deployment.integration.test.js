import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const driver = fileURLToPath(new URL('./helpers/instruction-deployment.js', import.meta.url));

// Boundary: actual init skill sync/template deployment, split activation and
// upgrade preparation/publication APIs, installed reference and installed
// onboarding shard resolving its packaged template. No full
// installer, service manager, tmux or authenticated runtimes. Run for packaged
// system templates, handoff references, sync or instruction generation changes;
// unrelated frontend changes may skip. Every bounded child uses private paths,
// read back before launch; cleanup runs even on child failure.
for (const mode of ['fresh', 'refresh']) test(`${mode} instruction deployment preserves owner instructions and installs handoff guidance`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instruction-deploy-'));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmp'), TZ: 'Asia/Singapore',
    ZYLOS_PACKAGE_ROOT: repo };
  try {
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
      fs.mkdirSync(env[key]);
      assert.ok(fs.realpathSync(env[key]).startsWith(fs.realpathSync(root) + path.sep), key);
    }
    console.log('Instruction deployment isolation:', JSON.stringify({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR,
      PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, TZ: env.TZ, tmux: 'not launched', pm2: 'not launched' }));
    const deployed = spawnSync(process.execPath, [driver, mode], { env, cwd: repo, encoding: 'utf8', timeout: 30000 });
    assert.equal(deployed.status, 0, `${deployed.error || ''}\n${deployed.stderr}\n${deployed.stdout}`);
    const initialized = spawnSync(process.execPath, [path.join(repo, 'skills/comm-bridge/scripts/c4-session-init.js')],
      { env, cwd: repo, encoding: 'utf8', timeout: 15000 });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.ok(initialized.stdout.includes(path.join(env.ZYLOS_DIR, 'memory/handoff.md')));
    assert.ok(initialized.stdout.includes(path.join(env.ZYLOS_DIR, '.claude/skills/comm-bridge/references/handoff-follow-up.md')));

    // A previously converted non-Origin group may still have Pending entries
    // in its retired state file and no handoff.
    const group = 'telegram:absorbed-pending';
    const groupDir = path.join(env.ZYLOS_DIR, 'memory/session-groups', group);
    fs.mkdirSync(groupDir, { recursive: true });
    const state = `<!-- zylos-state v1 | scope=${group} | synced_at=2026-01-01T00:00:00Z | coverage= | inbox_committed= -->

# Working State

## Headline

## In Progress

## Pending

- [Mode-switch messages] run=absorbed-fixture count=1 (#7–#7); reply: c4-send.js --absorbed-reply absorbed-fixture <id>; full text: c4-fetch.js --absorbed --run-id absorbed-fixture --id <id>
- #7 2026-01-01T00:00:00Z [telegram fixture] unfinished group request

## Commitments
`;
    fs.writeFileSync(path.join(groupDir, 'state.md'), state);
    assert.match(state, /## Pending\n\n- \[Mode-switch messages\] run=absorbed-fixture/);
    assert.equal(fs.existsSync(path.join(groupDir, 'handoff.md')), false);
    fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify({ session_mode: 'multi' }));
    const groupStart = spawnSync(process.execPath, [path.join(repo, 'skills/comm-bridge/scripts/c4-session-init.js')],
      { env: { ...env, ZYLOS_SESSION_GROUP: group }, cwd: repo, encoding: 'utf8', timeout: 15000 });
    assert.equal(groupStart.status, 0, groupStart.stderr);
    assert.ok(groupStart.stdout.includes(`No handoff file is available for this scope (${path.join(groupDir, 'handoff.md')}).`));
    assert.doesNotMatch(groupStart.stdout, /handoff-follow-up\.md/);
    for (const output of ['CLAUDE.md', 'AGENTS.md']) {
      const instructions = fs.readFileSync(path.join(env.ZYLOS_DIR, output), 'utf8');
      assert.match(instructions, /send a one-line transition notice via C4 before running `zylos runtime <target> --yes`/);
      assert.match(instructions, /Follow `~\/zylos\/\.claude\/skills\/comm-bridge\/references\/handoff-follow-up\.md` when a handoff exists or an internal notice concerns absorbed messages/);
    }
    const authRelay = fs.readFileSync(path.join(env.ZYLOS_DIR,
      '.claude/skills/component-management/references/runtime-switch.md'), 'utf8');
    assert.match(authRelay, /Send a brief transition notice through the original C4 reply route, then run\s+`zylos runtime <target> --yes`/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
