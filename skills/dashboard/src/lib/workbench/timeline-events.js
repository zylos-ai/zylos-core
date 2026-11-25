import { eventTypesFor } from '../../../public/js/wb/timeline-rows.js';
import { listFailure } from '../list-query.js';
import { isRestartExit, restartAssociated } from './restart-effects.js';
import { levels, timelinePage, timelineQuery } from './timeline-page.js';
import { commentaryRole, commentaryText, isActivityToolEvent, opensStep, stepLabel } from '../chat/activity.js';

function projectActivity(event, row) {
  const text = commentaryText(event);
  if (text) return { kind: 'commentary', text };
  if (!isActivityToolEvent(event)) return null;
  if (event.type === 'tool_call' && !opensStep(event)) return null;
  if (event.type === 'tool_result' && (event.meta.wraps_agent_tools || (!event.meta.resumes_cell &&
      !opensStep({ ...event, type: 'tool_call' })))) return null;
  const start = ['pre_tool_use', 'tool_call'].includes(event.type);
  const status = start || event.meta.cell_running ? 'running' : row.interrupted ? 'interrupted' :
    event.type === 'post_tool_failure' || event.meta.outcome === 'failed' ? 'failed' : 'done';
  return { kind: 'tool', label: stepLabel(event), status, start, duration: row.duration_ms ?? null };
}

export function projectTimelineEvent(row) {
  const event = { type: row.event_type, runtime: row.runtime, summary: row.summary, meta: row.metadata ?? {} };
  const role = commentaryRole(event);
  return { ...row, activity: projectActivity(event, row), ...(role ? { commentaryRole: role } : {}) };
}

export async function readTimelineEvents(store, key, singleOrigin, search, sanitize) {
  const query = timelineQuery(`group-events:${key}:${singleOrigin}`, search, {
    runId: value => value.length > 0 && Buffer.byteLength(value) <= 128 && !/[,\u0000-\u001f]/.test(value) ? value : undefined,
    filter: ['all', 'tools', 'lifecycle', 'subagents'],
    level: levels,
  });
  const { runId, filter = 'all', level } = query.filters;
  const types = eventTypesFor(filter, level);
  const args = { key, runId, limit: query.limit + 1 };
  const clauses = [singleOrigin ? "(event.session_group IS NULL OR event.session_group = 'origin')" : 'event.session_group = @key'];
  if (runId !== undefined) clauses.push('event.run_id = @runId');
  if (types !== null) {
    const placeholders = types.map((type, index) => {
      const name = `type${index}`;
      args[name] = type;
      return `@${name}`;
    });
    clauses.push(`event.event_type IN (${placeholders.join(',')})`);
  }
  if (query.after !== null) {
    [args.seq, args.id] = query.after;
    clauses.push(`(event.event_seq, event.id) ${query.operator} (@seq, @id)`);
  }
  const restartGroup = singleOrigin ? "restart.session_group IS NULL OR restart.session_group = 'origin'" : undefined;
  clauses.push(`NOT ${isRestartExit(restartGroup)}`);
  let page;
  try {
    const rows = store.db.prepare(`SELECT event.*, (event.event_type = 'post_tool_failure'
      AND ${restartAssociated(restartGroup)}) AS restart_interrupted FROM runtime_events event WHERE ${clauses.join(' AND ')}
      ORDER BY event.event_seq ${query.order}, event.id ${query.order} LIMIT @limit`).all(args);
    page = timelinePage(rows, query, row => [row.event_seq, row.id], [0, '']);
    page.items = page.items.map(({ restart_interrupted, ...row }) =>
      ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null, ...(restart_interrupted ? { interrupted: true } : {}) }));
  } catch { throw listFailure(503, 'unavailable', 'Group events unavailable'); }
  const items = await sanitize(page.items);
  return { ...page, items: level === 'technical' ? items : items.map(projectTimelineEvent) };
}
