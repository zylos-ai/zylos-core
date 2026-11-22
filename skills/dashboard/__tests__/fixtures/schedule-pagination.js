import * as schema from '../../../scheduler/scripts/schema.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';

export const LONG_PROMPT = '核对当天消息并整理工作记录。'.repeat(30) + '\n全文搜索标记 schedule-fulltext-tail';
export const SHARED_NEEDLE = 'schedule-shared';

// The stored next run matches the rule as the scheduler keeps it (UTC): every minute, or daily at an hour.
function nextRun(cron, now, fallback) {
  if (cron === '* * * * *') return (Math.floor(now / 60) + 1) * 60;
  const hour = cron?.match(/^0 (\d+) \* \* \*$/)?.[1];
  if (hour === undefined) return now + fallback;
  const day = Math.floor(now / 86400) * 86400 + Number(hour) * 3600;
  return day > now ? day : day + 86400;
}

/** Populate only the connection supplied by an already isolated test caller. */
export function populateSchedulePagination(db, now = Math.floor(Date.now() / 1000)) {
  guardDatabase(db, schema);
  const insert = db.prepare(`INSERT INTO tasks
    (id, name, prompt, type, cron_expression, interval_seconds, next_run_at, priority,
     status, require_idle, miss_threshold, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = [];
  const add = (id, name, type, status, cron = null, interval = null, prompt = '汇总工作进展，整理下一步。') => {
    prompt += `\n全量搜索标记 ${SHARED_NEEDLE}`;
    const row = { id, name, prompt, type, status, cron, interval, nextRunAt: nextRun(cron, now, id === 'once' ? 3600 : 60), updatedAt: now - rows.length };
    insert.run(id, name, prompt, type, cron, interval, row.nextRunAt, 3, status, 0, 300, now - 20 * 86400, row.updatedAt);
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
  return { rows, now, activeId: 'daily-0', longCompletedId: 'completed-100', prompt: rows.find(row => row.id === 'completed-100').prompt };
}

const SECTION = { pending: 0, running: 0, failed: 1, paused: 2, completed: 3 };

/** The documented list order: section, then next run (enabled) or newest update (others), then id. */
export function listOrder(rows) {
  const key = row => SECTION[row.status] === 0 ? row.nextRunAt : -row.updatedAt;
  return rows.slice().sort((a, b) => SECTION[a.status] - SECTION[b.status] || key(a) - key(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
