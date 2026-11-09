import * as schema from '../../../scheduler/scripts/schema.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';

export const LONG_PROMPT = '核对当天消息并整理工作记录。'.repeat(30) + '\n全文搜索标记 schedule-fulltext-tail';

/** Populate only the connection supplied by an already isolated test caller. */
export function populateSchedulePagination(db, now = Math.floor(Date.now() / 1000)) {
  guardDatabase(db, schema);
  const insert = db.prepare(`INSERT INTO tasks
    (id, name, prompt, type, cron_expression, interval_seconds, next_run_at, priority,
     status, require_idle, miss_threshold, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = [];
  const add = (id, name, type, status, cron = null, interval = null, prompt = '汇总工作进展，整理下一步。') => {
    const row = { id, name, prompt, type, status, cron, interval };
    insert.run(id, name, prompt, type, cron, interval, now + 60, 3, status, 0, 300, now - 20 * 86400, now - rows.length);
    rows.push(row);
    return row;
  };
  add('minute', '每分钟检查', 'recurring', 'pending', '* * * * *');
  for (let i = 0; i < 8; i++) add(`daily-${i}`, `每日工作简报 ${i + 1}`, 'recurring', 'pending', `0 ${8 + i} * * *`, null, i === 0 ? LONG_PROMPT : undefined);
  add('interval', '每小时整理', 'interval', 'pending', null, 3600);
  add('once', '待办事项提醒', 'one-time', 'pending');
  for (let i = 0; i < 8; i++) add(`paused-${i}`, `暂停任务 ${i + 1}`, 'recurring', 'paused', '0 9 * * *');
  for (let i = 0; i < 101; i++) add(`completed-${String(i).padStart(3, '0')}`, `已完成任务 ${String(i + 1).padStart(3, '0')}`, 'one-time', 'completed', null, null, i === 100 ? LONG_PROMPT : undefined);
  const history = db.prepare(`INSERT INTO task_history (task_id, executed_at, completed_at, status, duration_ms)
    VALUES (?, ?, ?, ?, ?)`);
  for (let i = 0; i < 290; i++) {
    const at = now - 60 - i * 1500;
    history.run(rows[i % rows.length].id, at, at + 2, i % 13 === 0 ? 'failed' : 'success', 2000);
  }
  return { rows, now, activeId: 'daily-0', longCompletedId: 'completed-100', prompt: LONG_PROMPT };
}
