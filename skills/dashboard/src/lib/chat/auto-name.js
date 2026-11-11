import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from '../../../../comm-bridge/scripts/sqlite-driver.js';
import { parseC4Content } from '../../../../comm-bridge/scripts/c4-content-schema.js';
import { Store } from '../store.js';
import { inspectDatabase, TARGET_SCHEMA_VERSION } from '../schema.js';
import { ChatConversations } from './conversations.js';

export const AUTO_NAME_PREFIX = '[Dashboard conversation naming]\n';
export const AUTO_NAME_DEADLINE_SECONDS = 300;
const root = env => env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');

export function withNamingStore(env, use) {
  const zylosDir = root(env);
  const file = path.join(zylosDir, 'components/dashboard/dashboard.db');
  const check = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (inspectDatabase(check).currentVersion !== TARGET_SCHEMA_VERSION) throw new Error('Dashboard requires an upgrade.');
  } finally { check.close(); }
  const store = new Store(file);
  try { return use(store, zylosDir); } finally { store.close(); }
}

function isReply(content) {
  const parsed = parseC4Content(content);
  return parsed.kind === 'text' || parsed.kind === 'envelope' && parsed.envelope.kind === 'message';
}

export function namingInstruction(group, zylosDir) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `node ${quote(path.join(zylosDir, '.claude/skills/dashboard/scripts/conversation-name.js'))} ${quote(group)} '<name>' --json`;
  return AUTO_NAME_PREFIX + '根据这个对话的当前上下文起一个恰当的短名字（20 字以内，语言与对话一致）。\n'
    + `用以下命令写回名称，将 <name> 替换为名称并正确转义 shell 参数：\n${command}\n`
    + '如果无法起名，用同一命令写入 unknown。名称已存在时保持现有名称。完成写回并确认结果后结束；不要在对话里回复用户。';
}

export function enqueueNamingControl({ group, content, zylosDir, env = process.env }) {
  const stdout = execFileSync(process.execPath,
    [path.join(zylosDir, '.claude/skills/comm-bridge/scripts/c4-control.js'), 'enqueue', '--group', group,
      '--content', content, '--ack-deadline', String(AUTO_NAME_DEADLINE_SECONDS), '--json'],
    { env: { ...env, ZYLOS_DIR: zylosDir }, timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  const reply = JSON.parse(stdout);
  if (!reply.ok || !Number.isSafeInteger(reply.data?.id)) throw new Error('Conversation naming control was not accepted.');
  return reply.data.id;
}

/** Called at the channel's verified outbound commit, never from a browser read. */
export function requestConversationName(row, { env = process.env, enqueue = enqueueNamingControl } = {}) {
  if (row.channel !== 'dashboard' || row.direction !== 'out' || row.delivery_action === 'system_notice' || !isReply(row.content)) return null;
  const file = path.join(root(env), 'components/dashboard/dashboard.db');
  if (!fs.existsSync(file)) return null;
  return withNamingStore(env, (store, zylosDir) => {
    const core = new Database(path.join(zylosDir, 'comm-bridge/c4.db'), { readonly: true, fileMustExist: true });
    try {
      return store.db.transaction(() => {
        const conversations = new ChatConversations({ store });
        const conversation = conversations.findByGroup(row.session_group);
        if (!conversation || conversation.localId !== row.endpoint_id) return null;
        // The first committed reply itself is the trigger. Controls are not replies;
        // subsequent replies never retry the decision, including after a cleared name.
        const previous = core.prepare(`SELECT content FROM conversations WHERE session_group=?
          AND channel='dashboard' AND endpoint_id=? AND direction='out'
          AND COALESCE(delivery_action,'')<>'system_notice' AND id<? ORDER BY id`).iterate(
          row.session_group, row.endpoint_id, row.id);
        for (const earlier of previous) if (isReply(earlier.content)) return null;
        if (conversation.displayName || store.getGroupDisplayName(row.session_group)?.display_name) return null;
        // A repeated channel delivery of the same committed first reply reuses the
        // control already in the queue. The queue record is the work, not a flag.
        if (core.prepare('SELECT 1 FROM control_queue WHERE session_group=? AND substr(raw_content,1,?)=? LIMIT 1')
          .get(row.session_group, AUTO_NAME_PREFIX.length, AUTO_NAME_PREFIX)) return null;
        try {
          return enqueue({ group: row.session_group, content: namingInstruction(row.session_group, zylosDir), zylosDir, env });
        } catch {
          conversations.renameIfEmpty(row.session_group, 'unknown');
          return null;
        }
      }).immediate();
    } finally { core.close(); }
  });
}

/** Existing C4 deadlines survive Dashboard restarts; no naming state is stored. */
export function reconcileConversationNames({ store, c4Reader, now = Date.now }) {
  const core = c4Reader._open();
  if (!core) return 0;
  const conversations = new ChatConversations({ store });
  const failed = core.prepare(`SELECT DISTINCT session_group FROM control_queue
    WHERE substr(raw_content,1,@length)=@prefix AND (status IN ('failed','timeout','superseded')
      OR (ack_deadline_at IS NOT NULL AND ack_deadline_at < @now))`)
    .all({ length: AUTO_NAME_PREFIX.length, prefix: AUTO_NAME_PREFIX, now: Math.floor(now() / 1000) });
  let updated = 0;
  for (const row of failed) {
    const conversation = conversations.findByGroup(row.session_group);
    if (!conversation || conversation.displayName || store.getGroupDisplayName(row.session_group)?.display_name) continue;
    if (conversations.renameIfEmpty(row.session_group, 'unknown').code === 'NAME_WRITTEN') updated++;
  }
  return updated;
}
