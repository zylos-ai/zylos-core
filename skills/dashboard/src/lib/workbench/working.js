export const END_TYPES = ['stop', 'turn_complete', 'dashboard_interrupt', 'runtime_health:stop_failure'];
export const TOOL_TYPES = ['pre_tool_use', 'post_tool_use', 'post_tool_failure'];
export const CHILD_TYPES = ['subagent_start', 'subagent_stop'];
/** What the main agent does: a prompt it takes, a message delivered to it, a tool call or result, or words it writes. */
export const MAIN_ACTION_TYPES = ['deliver', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'post_tool_failure',
  'permission_request', 'assistant_message', 'tool_call', 'tool_result'];
/** The main agent counts as working for this long after its latest action, unless it stopped since. */
const MAIN_RECENT_MS = 20_000;
export const eventTime = event => typeof event.timestamp === 'number' ? event.timestamp : Date.parse(event.timestamp);
export const compareEvents = (a, b) => eventTime(a) - eventTime(b) || (a.event_seq ?? 0) - (b.event_seq ?? 0);

/**
 * One display-only reducer for the current working value and historical busy intervals.
 * The group works while the main agent acted within the last few seconds and has not stopped since, a command still
 * runs (`tools`, from the session status) or a subtask has not ended. A subtask without a stop counts until it has
 * been quiet for `ttlMs`.
 */
export function workingHistory(events, end, { ttlMs = 1800000, tools = 0, toolLimitAt = end } = {}) {
  const seen = new Set();
  const ordered = events.filter(event => {
    if (!Number.isFinite(eventTime(event)) || eventTime(event) > end) return false;
    if (!Number.isSafeInteger(event.event_seq) || event.event_seq < 1) return true;
    if (seen.has(event.event_seq)) return false;
    seen.add(event.event_seq); return true;
  }).sort(compareEvents);
  const turns = [], children = [], toolHistory = [], openChildren = new Map(), openTools = new Map();
  let turn = null, main = null;
  for (const event of ordered) {
    const at = eventTime(event), meta = event.metadata ?? {}, child = meta.agent_id;
    // Recent main actions, however they reached the runtime: a message taken from the runtime's own queue starts
    // work without any prompt event.
    if (!child && MAIN_ACTION_TYPES.includes(event.event_type)) {
      if (!main || main.stopped || at - main.last >= MAIN_RECENT_MS) main = { since: at, last: at, stopped: false };
      else main.last = at;
    }
    if (!child && END_TYPES.includes(event.event_type) && main) main.stopped = true;
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
      const agent = { id: child, start: at, end: null, activity: [at] };
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
  // The open subtasks' agent ids, for the conversation page's subtask rows. A Codex agent id is the task path its
  // parent chose, so they never leave the server: not enumerable, they stay out of every JSON response.
  if (subagents) Object.defineProperty(subagents, 'ids', { value: active.map(agent => agent.id) });
  const recent = main && !main.stopped && end - main.last < MAIN_RECENT_MS ? { since: main.since, lastActivityAt: main.last } : null;
  const starts = [recent?.since, subagents?.since].filter(Number.isFinite);
  return { intervals, working: { on: recent !== null || tools > 0 || subagents !== null,
    since: starts.length ? Math.min(...starts) : null, main: recent, tools, subagents } };
}
