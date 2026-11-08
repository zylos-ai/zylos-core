import { labelledEvents, timeValue } from './event-labels.js?v=89';

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

/** Recent activity: the newest events first, with repeats merged. */
export function recentRows(events) {
  return mergeRepeats(newestFirst(events.map(event => ({ at: timeValue(event.timestamp), event }))));
}
