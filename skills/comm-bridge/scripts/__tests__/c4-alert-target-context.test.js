import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const worker = fileURLToPath(new URL('./fixtures/session-alert-target-worker.js', import.meta.url));
// The exact session-context lines; `web-console:console` is an ordinary value with no special case.
const expected = {
  configured: 'Alert target: telegram:8101553026. System alerts go there; change it only if the owner asks.',
  console: 'Alert target: web-console:console. System alerts go there; change it only if the owner asks.',
  origin: 'Alert target: dashboard:origin. System alerts go there; change it only if the owner asks.',
  default: 'Alert target: default (the owner chose the default destination, the pinned Origin conversation at the top of Dashboard\'s conversation list). Do not ask again.',
  paddedDefault: 'Alert target: default (the owner chose the default destination, the pinned Origin conversation at the top of Dashboard\'s conversation list). Do not ask again.',
  missing: 'Alert target: not set; system alerts (session unobservable, authentication failure) go to the default destination, the pinned Origin conversation at the top of Dashboard\'s conversation list. When the owner next messages you in a private chat on an IM channel (not Dashboard), ask once whether alerts should go to that chat. Before asking, run "zylos config get alert_target"; if another session has set it, do not ask. If the owner agrees, run "zylos config set alert_target <channel>:<endpoint>", where <endpoint> is the address that channel uses to send a new message to this private chat, not a reply to this particular message (see that channel\'s skill for its address format). If the owner declines, run "zylos config set alert_target default".',
  invalid: 'Alert target: invalid value; system alerts fall back to the pinned Origin conversation in Dashboard. Tell the owner and agree on a new value before changing it.',
  capitalDefault: 'Alert target: invalid value; system alerts fall back to the pinned Origin conversation in Dashboard. Tell the owner and agree on a new value before changing it.',
  unreadable: 'Alert target: UNAVAILABLE (instance config unreadable); do not write it.',
};
const states = {
  configured: { alert_target: 'telegram:8101553026' },
  console: { alert_target: 'web-console:console' },
  origin: { alert_target: 'dashboard:origin' },
  default: { alert_target: 'default' },
  paddedDefault: { alert_target: ' default ' },
  missing: {},
  invalid: { alert_target: 'no-destination' },
  capitalDefault: { alert_target: 'Default' },
  unreadable: '{bad json',
};
function fixture(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-context-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'instance');
  fs.mkdirSync(home); fs.mkdirSync(path.join(data, '.zylos'), { recursive: true });
  const file = path.join(data, '.zylos/config.json');
  if (config !== undefined) fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = config === undefined ? null : fs.readFileSync(file);
  return input => {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', worker, JSON.stringify(input)], {
      env: { ...process.env, HOME: home, ZYLOS_DIR: data, PM2_HOME: path.join(root, 'pm2'), TMUX: '', TMUX_PANE: '' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    if (original) assert.deepEqual(fs.readFileSync(file), original, 'startup context must not write F1');
    else assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(data, 'comm-bridge')), false, 'startup alert status must not create C4');
    return JSON.parse(result.stdout).output;
  };
}

for (const [state, config] of Object.entries(states)) {
  test(`alert context renders the exact ${state} instruction in every foreground scope`, async t => {
    const emit = fixture(t, config);
    for (const scope of [{ mode: 'single' }, { mode: 'multi', group: 'origin' }, { mode: 'multi', group: 'work' }]) {
      const output = emit(scope);
      const line = output.split('\n').find(row => row.startsWith('Alert target:'));
      assert.equal(line, expected[state]);
      assert.equal(line.includes('zylos config set'), state === 'missing');
      assert.match(output, /Scope: /);
      assert.match(output, /handoff\.md/);
    }
  });
}

test('a missing F1 file is an unset target rather than an unreadable configuration', t => {
  const output = fixture(t, undefined)({ mode: 'multi', group: 'work' });
  assert.ok(output.includes(expected.missing));
});

for (const payload of [{ agent_id: 'child' }, { agent_type: 'worker' }, { is_subagent: true }]) {
  test(`subsession identified by ${Object.keys(payload)[0]} receives no alert instruction`, t => {
    const output = fixture(t, states.missing)({ mode: 'multi', group: 'work', payload });
    assert.doesNotMatch(output, /Alert target:|zylos config set alert_target/);
    assert.match(output, /Scope: work/);
  });
}

test('long conversation tails are compacted before the intact unset-target instruction', t => {
  const emit = fixture(t, states.missing);
  const rows = [{ content: `OLD-TAIL ${'x'.repeat(10000)}` }, { content: 'LATEST-TAIL complete' }];
  const output = emit({ rows, budget: { maxChars: 1800, maxTokens: 100000 } });
  assert.ok(output.includes(expected.missing));
  assert.doesNotMatch(output, /OLD-TAIL/);
  assert.match(output, /LATEST-TAIL complete/);
  assert.ok(output.indexOf(expected.missing) < output.indexOf('LATEST-TAIL'));
  assert.ok(output.length <= 1800);
});
