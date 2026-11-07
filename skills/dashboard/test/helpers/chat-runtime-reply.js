import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Copied into the private fixture workspace; invoked by the real model's tool.
// It has no network client and can only send to its fixture-owned endpoint.
const [operation, localId, interruptId, observedSummary] = process.argv.slice(2);
const root = process.env.ZYLOS_DIR;
const payload = JSON.parse(fs.readFileSync(path.join(root, 'workspace/runtime-messages.json'), 'utf8'));
const group = payload.groups[localId];
if (!group) throw Error('Unknown fixture endpoint');
const send = (content, includeGroup = true) => {
  let script = path.join(root, '.claude/skills/comm-bridge/scripts/c4-send.js');
  if (!includeGroup) {
    // No route is saved in fixture data: the model must supply the executable,
    // channel and endpoint it observed in the real startup history.
    const observedScript = interruptId, observedChannel = observedSummary;
    if (!observedScript || observedChannel !== 'dashboard'
      || fs.realpathSync(observedScript) !== fs.realpathSync(script)) throw Error('Model must supply the observed startup route');
    script = observedScript;
  }
  const result = spawnSync(process.execPath, [script,
    'dashboard', localId, ...(includeGroup ? ['--session-group', localId] : [])], {
    cwd: root, env: process.env, input: content, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
  });
  if (result.status !== 0 || result.error) throw Error('Fixture channel send failed');
};
if (operation === 'initial') {
  for (const content of group.messages) send(content);
  send(`FIXTURE_SUPPLEMENT:${localId}`);
} else if (operation === 'acknowledge') {
  const question = group.questions.find(item => item.interruptId === interruptId);
  if (!question || question.questionSummary !== observedSummary) throw Error('Model did not supply the observed question summary');
  send(`FIXTURE_ANSWER_ACK:${interruptId}:${observedSummary}`);
} else if (operation === 'history-reply') {
  // The startup-history route intentionally omits --session-group. Endpoint
  // uniqueness and Core's own fallback must recover the original group.
  send(`FIXTURE_HISTORY_REPLY:${localId}`, false);
} else if (operation === 'canary') {
  send(`FIXTURE_CANARY:${localId}`);
} else throw Error('Unknown fixture operation');
