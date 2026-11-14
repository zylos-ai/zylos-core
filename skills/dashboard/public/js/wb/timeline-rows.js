import { labelledEvents, timeValue } from './event-labels.js?v=93';

// Which recorded events a person sees on the timeline and in recent activity.
// The plain view lists only events that have a plain-language label; router and
// pool diagnostics, runtime health samples and unknown codes are technical detail.
export const toolEventTypes = ['pre_tool_use', 'post_tool_use', 'post_tool_failure'];
export const plainEventTypes = [...labelledEvents];
export const lifecycleEventTypes = plainEventTypes.filter(type => !toolEventTypes.includes(type));

/** The filter chip an event belongs to, or null when no chip lists it (technical detail only). */
export function eventChip(event) {
  const type = event?.event_type;
  if (toolEventTypes.includes(type)) return 'tools';
  if (lifecycleEventTypes.includes(type)) return 'lifecycle';
  return null;
}

/**
 * The event types to ask the server for. A single chip asks for its own list; the unfiltered
 * view asks for every plain event in plain view and for everything in technical view (null).
 */
export function eventTypesFor(filter, level = 'plain') {
  if (filter === 'messages') return [];
  if (filter === 'tools') return toolEventTypes;
  if (filter === 'lifecycle') return lifecycleEventTypes;
  return level === 'technical' ? null : plainEventTypes;
}

/** Whether an event shows with these chips on: unlisted events only in technical view with every chip on. */
export function showsEvent(event, { chips, chipCount, level = 'plain' }) {
  const chip = eventChip(event);
  return chip ? chips.has(chip) : level === 'technical' && chips.size === chipCount;
}

// The supervisor restarts a run that stopped responding or whose tool ran too long, and the exit that restart causes is
// recorded a moment later in the same run as a crash. That record is the restart itself, already shown, not a crash.
export const RESTART_EXIT_MS = 10_000;
const automaticRestarts = new Set(['no_response_restart', 'tool_timeout_restart']);

/** For one run's events: whether an event is the crash report of an automatic restart at most RESTART_EXIT_MS before it. */
export function restartExit(events) {
  const restarts = events.filter(event => automaticRestarts.has(event.event_type)).map(event => timeValue(event.timestamp));
  return event => event.event_type === 'crash_detected' && restarts.some(at => {
    const gap = timeValue(event.timestamp) - at;
    return gap >= 0 && gap <= RESTART_EXIT_MS;
  });
}

const sequence = row => row.event?.event_seq ?? -Infinity;
/** Newest first; events recorded at the same moment keep their recorded order, latest first. */
export function newestFirst(rows) {
  return [...rows].sort((a, b) => (b.at || 0) - (a.at || 0) || sequence(b) - sequence(a));
}

// Two events read the same when they have the same type and, for tool events, the same tool.
const repeatKey = row => row.event ? `${row.event.event_type}\u0000${row.event.metadata?.tool_name ?? ''}` : null;

/**
 * Consecutive rows that read the same become one group: { count, newest, oldest }. Rows come
 * newest first, so `newest` is the group's first row. Messages never merge.
 */
export function mergeRepeats(rows) {
  const groups = [];
  for (const row of rows) {
    const key = repeatKey(row), last = groups.at(-1);
    if (key != null && last?.key === key) { last.count++; last.oldest = row; }
    else groups.push({ key, count: 1, newest: row, oldest: row });
  }
  return groups;
}

// Recent activity reads this many of the newest events and shows this many rows of them.
export const recentWindow = 100;
export const recentLimit = 5;

/**
 * Recent activity: the newest events first, with repeats merged, the first `limit` rows. When the read
 * filled its window, the group holding the window's earliest recorded event may continue before it:
 * that group is marked `open`, so its count is a lower bound and its first time is unknown. The server
 * cuts the window by recorded order, which can differ from timestamp order, so the open group is found
 * by recorded order, not by position.
 */
export function recentRows(events, { window = recentWindow, limit = recentLimit } = {}) {
  const rows = newestFirst(events.map(event => ({ at: timeValue(event.timestamp), event })));
  const groups = mergeRepeats(rows);
  if (events.length >= window && groups.length) {
    let edge = rows.length - 1;
    rows.forEach((row, index) => { if (sequence(row) < sequence(rows[edge])) edge = index; });
    let end = 0;
    for (const group of groups) {
      end += group.count;
      if (edge < end) { group.open = true; break; }
    }
  }
  return groups.slice(0, limit);
}
