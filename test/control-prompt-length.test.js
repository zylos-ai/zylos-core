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

// Claude Code folds a single input into pasted material when it is longer than
// PASTE_CHAR_THRESHOLD (String length) or has more than two line breaks; the model then reads it
// as quoted data instead of an instruction (Codex folds above 1000 characters, so 800 covers both).
// Conversation messages over the threshold go to a file; control text is typed in whole, so every
// control must stay within both limits. The router types a control as "Meanwhile, <content>"
// (comm-bridge router/delivery.js), and the store may append an ack suffix naming the installed
// c4-control.js and the control id.
const MAX_LINE_BREAKS = 2;
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
    ...['backlog', 'no_checkpoint', 'repair_failed'].flatMap(type =>
      ['pre_reclaim_retry'].map(repairAttempt => [`SYNC_BACKLOG_ALERT ${type} ${repairAttempt}`,
        syncPrompts.SYNC_BACKLOG_ALERT('group', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, LONG_GROUP, type,
          { reason: 'control_timeout', repairAttempt })])),
    ['DAILY_UPGRADE_PROMPT', DAILY_UPGRADE_PROMPT],
    ['HEALTH_CHECK_PROMPT', HEALTH_CHECK_PROMPT],
    ['startup prompt with handoff', startupPrompt(true)],
    ['startup prompt without handoff', startupPrompt(false)],
    ['migration prompt', migrationPrompt],
    ['conversation naming', namingInstruction(LONG_GROUP, LONG_INSTALL)],
  ];
}

test('every control prompt is typed as an ordinary input: within the paste length and line-break limits with the longest ack suffix', t => {
  const suffix = longestAckSuffix(t);
  const list = controls();
  for (const name of ['GROUP_SYNC_PROMPT', 'ORIGIN_SYNC_PROMPT', 'PRE_RECLAIM_CHECK_PROMPT', 'CONFIG_RECLAIM_PROMPT',
    'UPGRADE_RESTART_CHECK_PROMPT', 'SINGLE_UPGRADE_RESTART_CHECK_PROMPT', 'ROTATION_PROMPT', 'IDENTITY_ROTATION_PROMPT', 'conversation naming']) {
    assert.ok(list.some(([key]) => key === name), `${name} is measured`);
  }
  const over = [];
  for (const [name, content] of list) {
    assert.ok(typeof content === 'string' && content.length > 0, name);
    const text = delivered(content, suffix);
    const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
    if (text.length > PASTE_CHAR_THRESHOLD) over.push(`${name}: ${text.length} characters`);
    if (breaks > MAX_LINE_BREAKS) over.push(`${name}: ${breaks} line breaks`);
  }
  assert.equal(over.join('; '), '', `delivered controls over ${PASTE_CHAR_THRESHOLD} characters or ${MAX_LINE_BREAKS} line breaks`);
});
