import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const skill = fs.readFileSync(new URL('../../../new-session/SKILL.md', import.meta.url), 'utf8');
const commands = skill.split('\n').filter(line => line.startsWith('node ') && /enqueue --content "\/(clear|exit)"/.test(line));

test('new-session documents both runtime rotation commands', () => {
  assert.equal(commands.length, 2);
  assert.deepEqual(commands.map(command => command.match(/--content "([^"]+)"/)[1]).sort(), ['/clear', '/exit']);
});

for (const scope of ['multi', 'single', 'legacy']) {
  test(`new-session shell commands preserve the ${scope} target arguments`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const zylos = path.join(home, 'zylos');
    const scripts = path.join(zylos, '.claude/skills/comm-bridge/scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(new URL('./fixtures/new-session/c4-control.js', import.meta.url), path.join(scripts, 'c4-control.js'));
    for (const directory of ['pm2', 'tmp', 'tmux']) fs.mkdirSync(path.join(root, directory));
    const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux') };
    for (const key of ['ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'TMUX', 'TMUX_PANE']) delete env[key];
    if (scope !== 'legacy') env.ZYLOS_RUN_ID = 'run with spaces';
    if (scope === 'multi') env.ZYLOS_SESSION_GROUP = 'telegram:one';
    for (const command of commands) {
      const actual = JSON.parse(execFileSync('/bin/bash', ['-c', command], { env, cwd: root, encoding: 'utf8' }));
      const content = command.match(/--content "([^"]+)"/)[1];
      assert.deepEqual(actual, [
        'enqueue', '--content', content, '--priority', '1', '--block-queue-until-idle', '--no-ack-suffix',
        ...(scope === 'multi' ? ['--group', 'telegram:one'] : []),
        ...(scope !== 'legacy' ? ['--target-run', 'run with spaces'] : []),
      ]);
    }
  });
}
