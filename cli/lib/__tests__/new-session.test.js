import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const skill = fs.readFileSync(new URL('../../../skills/new-session/SKILL.md', import.meta.url), 'utf8');
const commands = [...skill.matchAll(/```bash\n([^`]+)\n```/g)].map(match => match[1]);

// Execute the documented commands, rather than reconstructing their arguments.
// These checks cover enqueue selection/rejection, not the agent's W4 merge or
// supervisor reclaim behavior; those require native workflow verification.
for (const runtime of ['codex', 'claude']) {
  for (const group of ['', 'origin', 'telegram:g-100123']) {
    for (const rejected of [false, true]) {
      test(`Documented ${runtime} exit command: ${group || 'single'}, ${rejected ? 'rejected' : 'accepted'}`, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'new-session-command-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const script = path.join(root, 'zylos/.claude/skills/comm-bridge/scripts/c4-control.js');
        const log = path.join(root, 'calls.jsonl');
        const handoff = path.join(root, 'handoff.md');
        fs.mkdirSync(path.dirname(script), { recursive: true });
        fs.writeFileSync(handoff, 'unfinished work\n');
        fs.writeFileSync(script, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');process.exit(${rejected ? 7 : 0});\n`);
        const switchCommand = runtime === 'codex' ? '/exit' : '/clear';
        const command = commands.find(text => text.includes(`--content "${switchCommand}"`));
        assert.ok(command, 'skill must provide a directly executable command');
        const env = { ...process.env, HOME: root };
        delete env.ZYLOS_SESSION_GROUP;
        if (group) env.ZYLOS_SESSION_GROUP = group;
        const result = spawnSync('bash', ['--noprofile', '--norc', '-c', command], { env, encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, rejected ? 7 : 0, result.stderr);
        const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(calls.length, 1, 'rejection must not loop or fall back');
        const argv = calls[0];
        assert.equal(argv[argv.indexOf('--content') + 1], switchCommand);
        assert.ok(argv.includes('--block-queue-until-idle'));
        assert.ok(argv.includes('--no-ack-suffix'));
        assert.equal(argv.filter(arg => arg === '--group').length, group ? 1 : 0);
        if (group) assert.equal(argv[argv.indexOf('--group') + 1], group);
        assert.equal(fs.readFileSync(handoff, 'utf8'), 'unfinished work\n');
      });
    }
  }
}
