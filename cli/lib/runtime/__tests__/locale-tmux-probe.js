// Invoked in a fresh process so tmux cannot inherit the test runner's locale.
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { settleLaunch } from '../session-launch.js';
import { writeSessionLaunchScript } from '../session-command.js';
import { openTmuxConnection } from '../tmux-connection.js';
import { observeSessionTarget } from '../session-target.js';
import { listGroupTmuxSessions, tmuxNameForGroup } from '../../session-group-paths.js';

const [dir, scenario, locale] = process.argv.slice(2);
assert.equal(process.env.LANG, locale === 'C' ? 'C' : undefined);
assert.equal(process.env.LC_ALL, undefined);
assert.equal(process.env.LC_CTYPE, undefined);
const binary = process.env.TEST_TMUX_BIN || 'tmux';
const socketPath = path.join(dir, 's');
// Fixture operations force UTF-8 independently; the calls under test must do so
// themselves. In particular, reader/list cases do not depend on launch passing.
const tmux = (...args) => execFileSync(binary, ['-u', '-S', socketPath, ...args],
  {encoding:'utf8', timeout:3000, stdio:['ignore','pipe','pipe']}).trim();
const launchConfig = {runtime:'claude', mode:'default'};
const sessionGroup = 'telegram:locale';
const tmuxName = tmuxNameForGroup(sessionGroup);
const runId = 'locale-run';
let connection, script;
try {
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', '/bin/sleep 30');
  if (scenario === 'launch-multi' || scenario === 'launch-single') {
    const group = scenario === 'launch-single' ? null : sessionGroup;
    const name = group === null ? 'origin' : tmuxName;
    script = writeSessionLaunchScript({command:'/bin/sleep', args:['30'],
      env:{PATH:process.env.PATH}, root:dir, multi:group !== null});
    const result = await settleLaunch({tmuxName:name, runId, launchConfig,
      sessionGroup:group, root:dir, script, tmux:{binary, socketPath}});
    assert.equal(result.tmuxName, name);
    assert.ok(Number.isSafeInteger(result.createdAt));
    assert.equal(tmux('show-environment', '-t', `=${name}`, 'ZYLOS_RUN_ID'), `ZYLOS_RUN_ID=${runId}`);
    assert.equal(tmux('show-environment', '-t', `=${name}`, 'ZYLOS_SESSION_GROUP'),
      group === null ? '-ZYLOS_SESSION_GROUP' : `ZYLOS_SESSION_GROUP=${group}`);
    assert.equal(tmux('list-panes', '-t', `=${name}`, '-F', '#{pane_current_command}'), 'sleep');
  } else {
    tmux('new-session', '-d', '-s', tmuxName, '-e', `ZYLOS_RUN_ID=${runId}`,
      '-e', `ZYLOS_MODEL_CONFIG=${JSON.stringify(launchConfig)}`,
      '-e', `ZYLOS_SESSION_GROUP=${sessionGroup}`, '/bin/sleep 30');
    if (scenario === 'observe') {
      connection = await openTmuxConnection({binary, socketPath, sessionName:'keeper'});
      const target = await observeSessionTarget({sessionGroup, tmuxName, connection});
      assert.equal(target.present, true);
      assert.equal(target.runId, runId);
      assert.equal(target.runtime, 'claude');
      assert.equal(target.rawF2.ZYLOS_SESSION_GROUP, sessionGroup);
      assert.match(target.tmuxSessionId, /^\$\d+$/);
      assert.match(target.paneId, /^%\d+$/);
      assert.ok(Number.isSafeInteger(target.createdAt));
    } else {
      assert.equal(scenario, 'list');
      const sessions = await listGroupTmuxSessions({binary, socketPath});
      assert.deepEqual(sessions, [{sessionGroup, tmuxName,
        createdAt:Number(tmux('display-message', '-p', '-t', `=${tmuxName}:`, '#{session_created}'))}]);
    }
  }
  console.log(JSON.stringify({scenario, locale, success:true,
    sessions:tmux('list-sessions', '-F', '#{session_name}').split('\n')}));
} finally {
  connection?.close();
  script?.cleanup();
  try { tmux('kill-server'); } catch {}
}
