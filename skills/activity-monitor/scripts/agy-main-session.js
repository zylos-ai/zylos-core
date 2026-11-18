/** Native AGY children have no parent marker: only the kick or statusLine may bind the main ID. */
import fs from 'node:fs';
import path from 'node:path';
import { loadCoreModule } from './core-modules.js';
const { runDirFromEnv } = await loadCoreModule('session-group-paths.js');
const { buildKickPrompt } = await loadCoreModule('runtime/kick-prompt.js');

function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function acceptAgyMainEvent(payload, event, env = process.env) {
  const id = payload?.conversationId;
  if (typeof id !== 'string' || !id) return null;
  const dir = runDirFromEnv(env).dir, runId = env.ZYLOS_RUN_ID || null;
  const file = path.join(dir, 'agy-main-session.json');
  const saved = read(file);
  let record = saved?.runId === runId && typeof saved.conversationId === 'string' && saved.conversationId ? saved : null;
  const sample = read(path.join(dir, 'statusline.json'));
  const statusId = runId && sample?.zylos?.v === 1 && sample.zylos.runId === runId
    ? sample.session_id ?? sample.conversation_id : null;
  const marker = read(path.join(dir, 'agy-session-source'));
  const clearing = marker?.runId === runId && marker.source === 'clear';
  const input = typeof payload.lastUserInput === 'string' ? payload.lastUserInput.trim() : '';
  const kick = event === 'SessionStart' && (input === buildKickPrompt() || input.startsWith(buildKickPrompt() + '\n'));
  if (record?.conversationId !== id) {
    if (!(statusId === id || kick) || (record && !clearing)) return null;
    record = { runId, conversationId: id, rulesPending: false };
    write(file, record);
  }
  return { file, record };
}

export function setAgyRulesPending(binding, pending) {
  binding.record.rulesPending = pending;
  write(binding.file, binding.record);
}
