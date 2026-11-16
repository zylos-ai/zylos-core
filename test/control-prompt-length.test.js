import test from 'node:test';
import assert from 'node:assert/strict';
import { PASTE_CHAR_THRESHOLD } from '../skills/comm-bridge/scripts/c4-config.js';
import { fixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import * as syncPrompts from '../skills/zylos-memory/scripts/sync-prompts.js';
import * as reclaimPrompts from '../skills/activity-monitor/scripts/reclaim-prompts.js';
import * as originPrompts from '../skills/activity-monitor/scripts/origin-prompts.js';
import { DAILY_UPGRADE_PROMPT, HEALTH_CHECK_PROMPT } from '../skills/activity-monitor/scripts/supervisor-machine-tasks.js';
import { migrationPrompt, startupPrompt } from '../skills/activity-monitor/scripts/session-start-prompt.js';
import { namingInstruction } from '../skills/dashboard/src/lib/chat/auto-name.js';

// Claude Code wraps a single input longer than PASTE_CHAR_THRESHOLD (String length) as pasted
// material, which the model reads as quoted data instead of an instruction. Conversation messages
// over the threshold go to a file; control text is typed in whole, so every control must fit.
// The router types a control as "Meanwhile, <content>" (comm-bridge router/delivery.js), and the
// store may append an ack suffix naming the installed c4-control.js and the control id.
const LONG_INSTALL = `/Users/${'u'.repeat(32)}/zylos`;
const LONG_GROUP = `telegram:${'g'.repeat(119)}`; // the 128-character session group limit
const delivered = (content, suffix) => `Meanwhile, ${content}${suffix}`;

function longestAckSuffix(t) {
  const { store } = fixture(t, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'single' } }) });
  const row = store.insertControl('probe');
  const suffix = row.content.slice('probe'.length);
  const match = suffix.match(/^ ---- ack via: node (\S+\/c4-control\.js) ack --id (\d+)$/);
  assert.ok(match, `unexpected ack suffix: ${suffix}`);
  // The installed script path under a long home directory and the largest control id.
  return suffix.replace(match[1], `${LONG_INSTALL}/.claude/skills/comm-bridge/scripts/c4-control.js`)
    .replace(/\d+$/, String(Number.MAX_SAFE_INTEGER));
}

function controls() {
  const fixed = Object.entries({ ...syncPrompts, ...reclaimPrompts, ...originPrompts })
    .filter(([, value]) => typeof value === 'string');
  return [
    ...fixed,
    ['SYNC_BACKLOG_ALERT', syncPrompts.SYNC_BACKLOG_ALERT(LONG_GROUP, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)],
    ['DAILY_UPGRADE_PROMPT', DAILY_UPGRADE_PROMPT],
    ['HEALTH_CHECK_PROMPT', HEALTH_CHECK_PROMPT],
    ['startup prompt with handoff', startupPrompt(true)],
    ['startup prompt without handoff', startupPrompt(false)],
    ['migration prompt', migrationPrompt],
    ['conversation naming', namingInstruction(LONG_GROUP, LONG_INSTALL)],
  ];
}

test('every control prompt is typed as an ordinary input, within the paste threshold with the longest ack suffix', t => {
  const suffix = longestAckSuffix(t);
  const list = controls();
  for (const name of ['GROUP_SYNC_PROMPT', 'ORIGIN_SYNC_PROMPT', 'PRE_RECLAIM_CHECK_PROMPT', 'CONFIG_RECLAIM_PROMPT',
    'UPGRADE_RESTART_CHECK_PROMPT', 'SINGLE_UPGRADE_RESTART_CHECK_PROMPT', 'ROTATION_PROMPT', 'IDENTITY_ROTATION_PROMPT']) {
    assert.ok(list.some(([key]) => key === name), `${name} is measured`);
  }
  const over = [];
  for (const [name, content] of list) {
    assert.ok(typeof content === 'string' && content.length > 0, name);
    const length = delivered(content, suffix).length;
    if (length > PASTE_CHAR_THRESHOLD) over.push(`${name}: ${length}`);
  }
  assert.equal(over.join('; '), '', `delivered controls over ${PASTE_CHAR_THRESHOLD} characters`);
});
