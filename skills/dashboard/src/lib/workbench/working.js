export const END_TYPES = ['stop', 'turn_complete', 'dashboard_interrupt'];
export const TOOL_TYPES = ['pre_tool_use', 'post_tool_use', 'post_tool_failure'];
export const CHILD_TYPES = ['subagent_start', 'subagent_stop'];
export const eventTime = event => typeof event.timestamp === 'number' ? event.timestamp : Date.parse(event.timestamp);
export const compareEvents = (a, b) => eventTime(a) - eventTime(b) || (a.event_seq ?? 0) - (b.event_seq ?? 0);

/** One display-only reducer for the current working value and historical busy intervals. */
export function workingHistory(events, end, { ttlMs = 1800000, tools = 0, toolLimitAt = end } = {}) {
  const seen = new Set();
  const ordered = events.filter(event => {
    if (!Number.isFinite(eventTime(event)) || eventTime(event) > end) return false;
    if (!Number.isSafeInteger(event.event_seq) || event.event_seq < 1) return true;
    if (seen.has(event.event_seq)) return false;
    seen.add(event.event_seq); return true;
  }).sort(compareEvents);
  const turns = [], children = [], toolHistory = [], openChildren = new Map(), openTools = new Map();
  let turn = null;
  for (const event of ordered) {
    const at = eventTime(event), meta = event.metadata ?? {}, child = meta.agent_id;
    if (!child && event.event_type === 'user_prompt_submit') {
      if (turn) turn.end = at;
      turn = { start: at, end: null, activity: [] }; turns.push(turn);
    }
    // Any event in this run refreshes the main turn, including assistant and child events.
    if (turn && (child || !END_TYPES.includes(event.event_type))) turn.activity.push(at);
    if (!child && END_TYPES.includes(event.event_type)) {
      if (turn) turn.end = at;
      turn = null;
      for (const tool of openTools.values()) tool.stop ??= at;
    }
    if (event.event_type === 'subagent_start' && child) {
      const previous = openChildren.get(child);
      if (previous) previous.end = at;
      const agent = { start: at, end: null, activity: [at] };
      children.push(agent); openChildren.set(child, agent);
    } else if (event.event_type === 'subagent_stop' && child) {
      const agent = openChildren.get(child);
      if (agent) agent.end = at;
      openChildren.delete(child);
    } else if (child && TOOL_TYPES.includes(event.event_type)) {
      openChildren.get(child)?.activity.push(at);
    }
    // Child tools refresh their child only; unmatched child tools never keep the main agent busy forever.
    if (child) continue;
    if (event.event_type === 'pre_tool_use') {
      const id = meta.tool_use_id ?? Symbol('tool');
      const tool = { start: at, end: null, stop: null }; toolHistory.push(tool); openTools.set(id, tool);
    } else if (TOOL_TYPES.slice(1).includes(event.event_type)) {
      const tool = openTools.get(meta.tool_use_id);
      if (tool) tool.end = at;
      openTools.delete(meta.tool_use_id);
    }
  }
  const intervals = [];
  for (const item of [...turns, ...children]) {
    for (const at of item.activity) intervals.push([at, Math.min(item.end ?? end, at + ttlMs)]);
  }
  intervals.push(...toolHistory.map(tool => [tool.start, tool.end ?? tool.stop ?? Math.min(end, toolLimitAt)]));
  const active = [...openChildren.values()].filter(agent => end - agent.activity.at(-1) < ttlMs);
  const subagents = active.length ? { count: active.length, since: Math.min(...active.map(agent => agent.start)),
    lastActivityAt: Math.max(...active.map(agent => agent.activity.at(-1))) } : null;
  const mainTurn = turn && (tools > 0 || end - turn.activity.at(-1) < ttlMs) ? { since: turn.start } : null;
  const starts = [mainTurn?.since, subagents?.since].filter(Number.isFinite);
  return { intervals, working: { on: mainTurn !== null || tools > 0 || subagents !== null,
    since: starts.length ? Math.min(...starts) : null, turn: mainTurn, tools, subagents } };
}
