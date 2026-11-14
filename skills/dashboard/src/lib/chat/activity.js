import { createHash, randomUUID } from 'node:crypto';
import { END_TYPES, MAIN_ACTION_TYPES, STOP_HOOK_LAG_MS, inputAfterStop } from '../workbench/working.js';

/**
 * What the agent is doing right now, for a Dashboard conversation page.
 *
 * Runtime events are recorded per group, and a message taken from the runtime's own queue starts work without any
 * event of its own, so actions are never tied to the message that caused them. The page shows the group's current
 * work instead: the main agent's steps since the last reply in this conversation or since the group was last quiet
 * (whichever is later), a mark where a new input reached the session or a subtask began, and one row per subtask
 * that has not ended. Whether the group works at all comes from the same reading as the conversation header, and the
 * page's header takes its reading from this read too.
 * Steps carry only the one-line summaries the event store already holds: no tool output, no command text, no
 * thinking and none of the words the agent writes between steps.
 */

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const STEP_TYPES = ['pre_tool_use', 'post_tool_use', 'post_tool_failure', 'tool_call', 'tool_result',
  'subagent_start', 'subagent_stop', 'assistant_message', 'deliver', 'input_dequeue', 'user_prompt_submit'];
// Collectors read transcripts every 5 s, so a step's end or a queued message the runtime took after the stop may be
// recorded a little later. For this long after a stop, steps without an end keep running, and work that ended without
// a reply is still settling: the page already says it was handled, but keeps reading often.
export const SETTLE_MS = 20_000;
const STEP_LIMIT = 1500, STEPS_SHOWN = 500, QUIET_LOOKBACK = 50, UNANSWERED_LIMIT = 50, SUBTASK_START_LIMIT = 200;
// How long before a subtask's start the call that launched it may be.
const LAUNCH_LEAD_MS = 10_000;
/**
 * The router records a message's delivery once it has typed it in and seen it land, which is after the runtime
 * reported the prompt for it: about half a second later on real hosts. A delivery this soon after an unmatched prompt
 * is that prompt's message.
 */
const PROMPT_DELIVERY_LAG_MS = 2_000;
// Memory Sync workers, named by what they do rather than by their worker type.
const MEMORY_SYNC_AGENTS = /^zylos-(group|origin|global)-sync$/;
// Calls that manage subagents rather than do work (both multi-agent tool generations, including an `exec` that
// calls them from code mode); the subagent itself is a subtask row. A code-mode `wait` with a cell id is not one of
// them: it resumes a yielded `exec`, whose step it ends.
const CODEX_AGENT_CONTROLS = new Set(['spawn_agent', 'send_input', 'wait_agent', 'close_agent', 'resume_agent',
  'send_message', 'list_agents', 'followup_task', 'interrupt_agent', 'wait', 'sleep']);
const CODEX_COMMANDS = new Set(['exec', 'exec_command', 'shell', 'local_shell', 'container.exec', 'write_stdin', 'unified_exec']);
const CLAUDE_AGENT_TOOLS = new Set(['Agent', 'Task']);

const toolName = meta => typeof meta.tool_name === 'string' ? meta.tool_name.replace(/^functions\./, '') : '';
const iso = ms => new Date(ms).toISOString();
const ms = value => { const time = Date.parse(value); return Number.isFinite(time) ? time : null; };
/** C4 stores UTC seconds as `YYYY-MM-DD HH:MM:SS`. */
const c4Time = value => typeof value === 'string' ? ms(value.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z')) : null;
const parse = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
const shortPath = value => String(value).split('/').filter(Boolean).slice(-3).join('/');
const plain = value => typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
/**
 * The page's handle for a subtask. A Codex agent id is the task path the parent chose, so the id itself is never
 * shown; the page names a subtask by this digest and opens only one that is still running.
 */
export const subtaskKey = id => createHash('sha256').update(id).digest('base64url').slice(0, 22);
const agentOf = event => typeof event.meta.agent_id === 'string' && event.meta.agent_id ? event.meta.agent_id : null;
/**
 * The prompt time of each delivery among main-agent rows in time order: the earliest prompt not yet matched at most
 * PROMPT_DELIVERY_LAG_MS before it. A delivery recorded before its prompt, or without one, has none.
 */
function promptTimes(rows) {
  const open = [], times = new Map();
  for (const row of rows) {
    if (row.type === 'user_prompt_submit') open.push(row.at);
    else if (row.type === 'deliver') {
      while (open.length && row.at - open[0] > PROMPT_DELIVERY_LAG_MS) open.shift();
      if (open.length) times.set(row, open.shift());
    }
  }
  return times;
}

/** One display label per step: a translation key and an optional plain argument; never a tool name or raw input. */
export function stepLabel(event) {
  const meta = event.meta;
  const tool = toolName(meta);
  const detail = plain(meta.tool_detail);
  if (event.runtime === 'codex') {
    if (CODEX_COMMANDS.has(tool)) return { key: 'runCommand' };
    if (tool === 'apply_patch') {
      const files = (plain(event.summary) ?? '').replace(/^Edit files:?\s*/, '').split(', ').filter(Boolean);
      return files.length === 1 ? { key: 'edit', arg: shortPath(files[0]) } : { key: 'editFiles' };
    }
    return { key: 'tool' };
  }
  if (['Read', 'Edit', 'Write'].includes(tool)) return detail ? { key: tool.toLowerCase(), arg: detail } : { key: 'tool' };
  if (tool === 'Bash') return detail && meta.detail_source === 'description' ? { key: 'described', arg: detail } : { key: 'runCommand' };
  if (tool === 'WebSearch' && detail) return { key: 'search', arg: detail };
  if (tool === 'WebFetch' && detail) return { key: 'open', arg: detail };
  if (tool === 'Skill' && detail) return { key: 'skill', arg: detail };
  return { key: 'tool' };
}

/**
 * A subtask's name: Memory Sync by what it does, otherwise the short description of the Claude call that launched it,
 * otherwise a plain "subtask". What Codex records with a start is the message the subtask was given or a generated
 * nickname, never a name, so it is not shown.
 */
function subtaskLabel(start, launch = null) {
  const meta = start.meta;
  if (typeof meta.agent_type === 'string' && MEMORY_SYNC_AGENTS.test(meta.agent_type)) return { key: 'memorySync' };
  const named = plain(launch?.meta.tool_detail);
  return named ? { key: 'named', arg: named } : { key: 'plain' };
}

/**
 * Pairs each Claude subtask start with the main-agent call that launched it: the latest unpaired Agent/Task call
 * shortly before it.
 */
function subtaskLaunches(events) {
  const launches = new Map(), calls = [];
  for (const event of events) {
    if (event.type === 'pre_tool_use' && !agentOf(event) && CLAUDE_AGENT_TOOLS.has(toolName(event.meta))) calls.push(event);
    else if (event.type === 'subagent_start' && agentOf(event) && event.runtime !== 'codex') {
      const index = calls.findLastIndex(call => call.at <= event.at && event.at - call.at <= LAUNCH_LEAD_MS);
      if (index >= 0) launches.set(agentOf(event), calls.splice(index, 1)[0]);
    }
  }
  return launches;
}

/** Records a Dashboard interrupt so the work it stopped is shown as stopped. */
export function recordGroupInterrupt(store, { sessionGroup, runId = null, sessionId = null, controlId = null, at = Date.now() } = {}) {
  if (!store || typeof sessionGroup !== 'string' || !sessionGroup) return null;
  const id = randomUUID();
  return store.insertEvent({ id, ingest_id: `dashboard-interrupt-${id}`, timestamp: iso(at), runtime: 'unknown',
    session_id: sessionId, session_group: sessionGroup, run_id: runId, event_type: 'dashboard_interrupt',
    category: 'turn', summary: 'Interrupted from Dashboard', metadata: { control_id: controlId }, source: 'dashboard' });
}

/**
 * Whether a tool call opens a step in an agent's list: the same rule decides what a subtask row counts and what it
 * shows when opened. Calls that launch or manage subagents, and a code-mode `wait` that reads more of an earlier
 * `exec`, are not steps.
 */
export function opensStep(event) {
  if (event.runtime === 'codex' ? event.type !== 'tool_call' : event.type !== 'pre_tool_use') return false;
  const meta = event.meta, tool = toolName(meta);
  if (event.runtime !== 'codex') return !CLAUDE_AGENT_TOOLS.has(tool) && !!meta.tool_use_id;
  if (typeof meta.resumes_cell === 'string' || CODEX_AGENT_CONTROLS.has(tool)) return false;
  if (Array.isArray(meta.wraps_agent_tools) && meta.wraps_agent_tools.length) return false;
  return !!(meta.tool_use_id ?? meta.call_id);
}

/**
 * One agent's steps from its events (time order), keyed so a start and its end become one step: the main agent's
 * when `agent` is null, otherwise that subtask's. `ends` are the times that agent stopped ({ at, stopped }, stopped
 * when it was interrupted); a step still open at a stop that is at least SETTLE_MS old was left unfinished there, or
 * stopped by the interrupt (a yielded code-mode command no `wait` saw finish is taken to have ended there), otherwise
 * it is still running. When there are more steps than can be shown, the newest are kept.
 */
export function buildSteps(events, { agent = null, ends = [], now }) {
  let steps = [], truncated = false;
  const open = new Map(), cells = new Map();
  for (const event of events) {
    if (agentOf(event) !== agent) continue;
    const meta = event.meta;
    if (!['pre_tool_use', 'post_tool_use', 'post_tool_failure', 'tool_call', 'tool_result'].includes(event.type)) continue;
    if (event.runtime === 'codex' && ['pre_tool_use', 'post_tool_use', 'post_tool_failure'].includes(event.type)) continue;
    if (event.runtime !== 'codex' && ['tool_call', 'tool_result'].includes(event.type)) continue;
    // A `wait` on a code-mode cell reads more of the `exec` that yielded it; the exec's step ends when one reports the
    // script finished.
    if (event.runtime === 'codex' && typeof meta.resumes_cell === 'string') {
      const step = event.type === 'tool_result' && !meta.cell_running ? cells.get(meta.resumes_cell) : null;
      if (step && step.end === null) {
        step.end = event.at;
        step.status = meta.outcome === 'failed' ? 'failed' : 'done';
        cells.delete(meta.resumes_cell);
      }
      continue;
    }
    const key = meta.tool_use_id ?? meta.call_id ?? '';
    if (!key) continue;
    if (['pre_tool_use', 'tool_call'].includes(event.type)) {
      // A subtask is shown as its own row, not as the calls that launch or manage it.
      if (!opensStep(event) || open.has(key)) continue;
      const step = { kind: 'tool', label: stepLabel(event), status: 'running', start: event.at, end: null };
      steps.push(step); open.set(key, step);
    } else {
      const step = open.get(key);
      if (!step || step.end !== null) continue;
      // An `exec` that yielded while its script still runs goes on until a `wait` on its cell sees it finish.
      if (event.type === 'tool_result' && meta.cell_running && typeof meta.cell_id === 'string') { cells.set(meta.cell_id, step); continue; }
      step.end = event.at;
      step.status = event.type === 'post_tool_failure' || meta.outcome === 'failed' ? 'failed' : 'done';
    }
  }
  if (steps.length > STEPS_SHOWN) { steps = steps.slice(-STEPS_SHOWN); truncated = true; }
  const unread = new Set(cells.values());
  for (const step of steps) {
    if (step.end !== null) continue;
    const stop = ends.find(entry => entry.at >= step.start);
    if (stop !== undefined && now - stop.at >= SETTLE_MS) {
      step.status = stop.stopped ? 'stopped' : unread.has(step) ? 'done' : 'incomplete';
      step.end = stop.at;
    }
  }
  return { steps, truncated };
}

/**
 * Steps and marks in time order. A mark for a message of this conversation or for a subtask before anything else is
 * dropped: that message is the one the area sits under, and the subtask has its own row. A scheduled task, a system
 * instruction or another message says why the work began, so its mark stays, even before any step.
 */
export function interleave(steps, marks) {
  const items = [...steps, ...marks].sort((a, b) => (a.start ?? a.at) - (b.start ?? b.at));
  const first = items.findIndex(item => item.kind !== 'mark' || !['message', 'subtask'].includes(item.mark));
  return first < 0 ? [] : items.slice(first);
}

/**
 * The `working(group)` reader for ChatActivity from the workbench snapshot (`getSnapshot`, `hotTtlMs`): the group's row,
 * the Origin row for the Origin group, so the conversation page and its header read the same thing. The header's
 * fields (`presence`, `wait`, `health`, the session's runtime health) are known only when the snapshot read the group
 * list and the session status; `readAt` is when it read the status, to tell a newer reading from an older one.
 */
export function snapshotWorking(workbench, { origin }) {
  return async group => {
    const snapshot = await workbench.getSnapshot();
    const row = snapshot?.rows?.find(item => group === origin ? item.origin === true : item.sessionGroup === group);
    if (!row) return null;
    const trusted = snapshot.listKnown === true && snapshot.sources?.status?.ok === true;
    return { working: row.working ?? null, presence: row.presence ?? null, ttlMs: workbench.hotTtlMs(),
      header: trusted ? { readAt: snapshot.sources.status.readAt, presence: row.presence ?? null, wait: row.wait ?? null,
        health: snapshot.instance?.runtimeHealth?.[row.target?.runtime]?.health ?? null } : null };
  };
}

export class ChatActivity {
  /**
   * `working(group)` returns the group's row of the workbench snapshot the conversation header reads ({ working,
   * presence }), so the page and its header agree on whether the group works and which subtasks are open.
   */
  constructor({ history, store, working = async () => null, now = Date.now }) {
    this.history = history;
    this.store = store;
    this.working = working;
    this.now = now;
  }

  _events(sql, parameters) {
    try { return this.store.db.prepare(sql).all(parameters); }
    catch { throw fail('chat_activity_unavailable', 502); }
  }

  _row(row) {
    const meta = parse(row.metadata);
    return { type: row.event_type, at: ms(row.timestamp), session: row.session_id ?? null, runtime: row.runtime,
      summary: row.summary, meta, seq: row.event_seq };
  }

  /**
   * A Dashboard interrupt ends the main agent's work only once C4 has delivered its Escape to the session, and it
   * ends it at the delivery time; an interrupt still queued, failed or expired is not a stop.
   */
  _deliveredInterrupts(rows) {
    const ids = [...new Set(rows.filter(row => row.type === 'dashboard_interrupt')
      .map(row => Number(row.meta.control_id)).filter(Number.isSafeInteger))];
    if (!rows.some(row => row.type === 'dashboard_interrupt')) return rows;
    let controls = new Map();
    if (ids.length) {
      try {
        controls = new Map(this.history._query(`SELECT id, status, updated_at FROM control_queue
          WHERE id IN (SELECT value FROM json_each(@ids))`, { ids: JSON.stringify(ids) }).map(row => [row.id, row]));
      } catch { /* Unknown delivery: the interrupt is not a stop. */ }
    }
    return rows.flatMap(row => {
      if (row.type !== 'dashboard_interrupt') return [row];
      const control = controls.get(Number(row.meta.control_id));
      if (control?.status !== 'done') return [];
      const delivered = Number(control.updated_at) * 1000;
      return [{ ...row, at: Number.isFinite(delivered) ? Math.max(row.at, delivered) : row.at }];
    }).sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
  }

  /** The main agent's latest stops, newest first, each with whether a subtask was still open at that moment. */
  _stops(group, now) {
    const rows = this._deliveredInterrupts(this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata
      FROM runtime_events WHERE session_group=@group AND event_type IN (${END_TYPES.map(type => `'${type}'`).join(',')})
      AND (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.agent_id') END) IS NULL AND timestamp <= @now
      ORDER BY timestamp DESC, event_seq DESC LIMIT ${QUIET_LOOKBACK}`, { group, now: iso(now) }).map(row => this._row(row)));
    return rows.sort((a, b) => b.at - a.at || (b.seq ?? 0) - (a.seq ?? 0));
  }

  /** Subtask starts and stops from a time on, to tell which stops left the group quiet. */
  _children(group, from, now) {
    return this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata FROM runtime_events
      WHERE session_group=@group AND event_type IN ('subagent_start','subagent_stop') AND timestamp >= @from AND timestamp <= @now
      ORDER BY timestamp, event_seq LIMIT ${STEP_LIMIT}`, { group, from: iso(from), now: iso(now) }).map(row => this._row(row));
  }

  /**
   * The latest stop of the main agent at which no subtask was running (`quiet`, the moment the group was last quiet),
   * and when the work around the latest stop settled (`settled`): that stop, or the end of the last subtask still
   * running at it; null while one of those still runs. A subtask open at a stop was running there if it reported its
   * end later or the header still counts it (`live`, its open subtasks); one that never reported its end and the
   * header no longer counts was not. Without the header's reading, one counts while its start is within `ttlMs`.
   */
  _quietSince(group, now, ttlMs, live = null) {
    const stops = this._stops(group, now);
    if (!stops.length) return { quiet: null, settled: null, stops };
    const children = this._children(group, stops.at(-1).at - ttlMs, now);
    const counted = (id, start) => live ? live.has(id) : now - start < ttlMs;
    let quiet = null, settled;
    for (const stop of stops) {
      const open = new Map(), ended = new Map();
      for (const child of children) {
        const id = agentOf(child);
        if (!id) continue;
        if (child.at <= stop.at) {
          if (child.type === 'subagent_start') open.set(id, child.at); else open.delete(id);
        } else if (child.type === 'subagent_stop' && open.has(id) && !ended.has(id)) ended.set(id, child.at);
      }
      const running = [...open].filter(([id, start]) => ended.has(id) || counted(id, start)).map(([id]) => id);
      if (settled === undefined) settled = running.some(id => !ended.has(id)) ? null : Math.max(stop.at, ...running.map(id => ended.get(id)));
      if (!running.length) { quiet = stop.at; break; }
    }
    // Every stop read had a subtask running: the oldest bounds the window only when older stops were left unread.
    if (quiet === null && stops.length >= QUIET_LOOKBACK) quiet = stops.at(-1).at;
    return { quiet, settled, stops };
  }

  /** Where deliveries came from: this conversation, a scheduled task, a system instruction or anything else. */
  _markKinds(range, deliveries) {
    const ids = [...new Set(deliveries.map(event => positiveId(event.meta.conversation_id)).filter(Boolean))];
    const rows = ids.length ? this.history._query(`SELECT c.id, c.channel, c.direction, (${range.where}) AS mine FROM conversations c
      WHERE c.id IN (SELECT value FROM json_each(@ids))`, { ...range.parameters, ids: JSON.stringify(ids) }) : [];
    const byId = new Map(rows.map(row => [row.id, row]));
    return event => {
      const id = positiveId(event.meta.conversation_id);
      if (id === null) return positiveId(event.meta.control_id) === null ? null : { mark: 'control' };
      const row = byId.get(id);
      if (row?.mine && row.direction === 'in') return { mark: 'message', messageId: id };
      return { mark: row?.channel === 'scheduler' ? 'scheduled' : 'other' };
    };
  }

  /** The conversation's latest reply and the user messages after it, oldest first. */
  _unanswered(range) {
    const reply = this.history._query(`SELECT c.id, c.timestamp FROM conversations c WHERE ${range.where}
      AND c.direction='out' ORDER BY c.id DESC LIMIT 1`, range.parameters)[0] ?? null;
    const messages = this.history._query(`SELECT c.id, c.timestamp, c.status FROM conversations c WHERE ${range.where}
      AND c.direction='in' AND c.id > @after ORDER BY c.id DESC LIMIT ${UNANSWERED_LIMIT}`, { ...range.parameters, after: reply?.id ?? 0 }).reverse();
    return { reply: reply ? { id: reply.id, at: c4Time(reply.timestamp) } : null, messages };
  }

  /**
   * The latest unanswered user message and how far it got: `queued` until the session takes it, `thinking` once
   * delivered while the header's reading says the main agent works (`busy`), `settling` (the page already says it
   * was handled, but keeps reading often) from when the work around the stop after it settled until SETTLE_MS later,
   * since the runtime may still take a queued message, and `handled` once that passed with nothing more done (`acted`
   * is the main agent's latest action). Null otherwise: answered, waiting in C4 too long, or delivered and left idle.
   */
  _awaiting(group, unanswered, { stops, settled, acted, busy }, now) {
    const latest = unanswered.at(-1);
    if (!latest) return null;
    const sent = c4Time(latest.timestamp) ?? now;
    const delivered = this._events(`SELECT timestamp FROM runtime_events WHERE session_group=@group AND event_type='deliver'
      AND timestamp >= @from AND json_extract(metadata, '$.conversation_id') = @id ORDER BY timestamp LIMIT 1`,
    { group, from: iso(sent - 60_000), id: latest.id })[0];
    if (!delivered) {
      if (['pending', 'running'].includes(latest.status) || now - sent <= 2 * 60_000) return { id: latest.id, state: 'queued', since: sent };
      return null;
    }
    const at = ms(delivered.timestamp);
    if (busy) return { id: latest.id, state: 'thinking', since: sent, delivered: at };
    if (!(stops[0]?.at >= at) || settled === null || acted > settled) return null;
    return { id: latest.id, state: now - settled >= SETTLE_MS ? 'handled' : 'settling', since: sent, delivered: at };
  }

  /** The open subtasks the header counts, with their names, starts and how many steps each has taken so far. */
  _subtasks(group, ids, now) {
    if (!ids.length) return [];
    const starts = this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata FROM runtime_events
      WHERE session_group=@group AND event_type='subagent_start' AND json_extract(metadata, '$.agent_id') IN (SELECT value FROM json_each(@ids))
      AND timestamp <= @now ORDER BY timestamp DESC, event_seq DESC LIMIT ${SUBTASK_START_LIMIT}`, { group, ids: JSON.stringify(ids), now: iso(now) })
      .reverse().map(row => this._row(row));
    const latest = new Map();
    for (const start of starts) latest.set(agentOf(start), start);
    const first = Math.min(...[...latest.values()].map(start => start.at));
    const launchers = Number.isFinite(first) ? this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata
      FROM runtime_events WHERE session_group=@group AND event_type='pre_tool_use' AND json_extract(metadata, '$.tool_name') IN ('Agent','Task')
      AND timestamp >= @from AND timestamp <= @now ORDER BY timestamp, event_seq LIMIT ${STEP_LIMIT}`,
    { group, from: iso(first - LAUNCH_LEAD_MS), now: iso(now) }).map(row => this._row(row)) : [];
    const launches = subtaskLaunches([...launchers, ...starts].sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0)));
    // Each row counts the steps its open list shows: one per call that opens a step since that subtask's start.
    const calls = Number.isFinite(first) ? this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata
      FROM runtime_events WHERE session_group=@group AND event_type IN ('pre_tool_use','tool_call')
      AND json_extract(metadata, '$.agent_id') IN (SELECT value FROM json_each(@ids)) AND timestamp >= @from AND timestamp <= @now
      ORDER BY timestamp DESC, event_seq DESC LIMIT ${STEP_LIMIT * ids.length}`, { group, ids: JSON.stringify(ids), from: iso(first), now: iso(now) })
      .map(row => this._row(row)) : [];
    const keys = new Map();
    for (const call of calls) {
      const id = agentOf(call);
      if (!latest.has(id) || call.at < latest.get(id).at || !opensStep(call)) continue;
      if (!keys.has(id)) keys.set(id, new Set());
      keys.get(id).add(call.meta.tool_use_id ?? call.meta.call_id);
    }
    const counts = new Map([...keys].map(([id, set]) => [id, set.size]));
    return ids.filter(id => latest.has(id)).map(id => {
      const start = latest.get(id);
      return { id: subtaskKey(id), label: subtaskLabel(start, launches.get(id)), start: start.at, steps: counts.get(id) ?? 0 };
    }).sort((a, b) => a.start - b.start);
  }

  async _group(range) {
    const group = range.parameters.group;
    let row = null;
    try { row = await this.working(group); } catch { row = null; }
    return { working: row?.working ?? null, presence: row?.presence ?? null, header: row?.header ?? null, ttlMs: row?.ttlMs ?? 30 * 60_000 };
  }

  /**
   * Messages the runtime held in its own queue while the main agent worked, and took as `taken` (a queued message
   * taken, recorded at `recorded` when it counts after a stop): the deliveries after the input that started the work
   * before it and before the window's start `from` (later ones are in the window already). The main agent's inputs
   * are replayed with its `stops`: a queued message taken starts work, and a prompt starts work only while the main
   * agent is not working, since the runtime also reports a prompt when a message is queued mid-turn.
   */
  _held(group, taken, from, stops) {
    const until = taken.recorded ?? taken.at;
    const main = '(CASE WHEN json_valid(metadata) THEN json_extract(metadata, \'$.agent_id\') END) IS NULL';
    const rows = this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata FROM runtime_events
      WHERE session_group=@group AND event_type IN ('deliver','user_prompt_submit','input_dequeue','input_remove') AND ${main}
      AND timestamp >= @from AND timestamp <= @until ORDER BY timestamp DESC, event_seq DESC LIMIT ${QUIET_LOOKBACK}`,
    { group, from: iso(until - 24 * 3600_000), until: iso(until) }).reverse().map(row => this._row(row));
    if (!rows.length) return [];
    // A queued message taken shortly before a stop counts after it unless the main agent acted in between, so the
    // replay also reads the main agent's other actions just before each stop.
    const near = stops.filter(stop => stop.at >= rows[0].at && stop.at <= taken.at);
    const acts = near.length ? this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata FROM runtime_events
      WHERE session_group=@group AND event_type IN (${MAIN_ACTION_TYPES.map(type => `'${type}'`).join(',')}) AND ${main}
      AND EXISTS (SELECT 1 FROM json_each(@ranges) WHERE timestamp >= json_extract(value, '$[0]') AND timestamp <= json_extract(value, '$[1]'))
      ORDER BY timestamp, event_seq LIMIT ${STEP_LIMIT}`,
    { group, ranges: JSON.stringify(near.map(stop => [iso(stop.at - STOP_HOOK_LAG_MS), iso(stop.at)])) }).map(row => this._row(row)) : [];
    const seen = new Set(rows.map(row => row.seq));
    const ordered = [...rows, ...acts.filter(act => !seen.has(act.seq)), ...near]
      .sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
    const counted = inputAfterStop(ordered, { type: event => event.type, at: event => event.at, child: agentOf });
    const replay = ordered.map(event => ({ event, at: counted(event) })).sort((a, b) => a.at - b.at || (a.event.seq ?? 0) - (b.event.seq ?? 0));
    // When the input that started the work is no longer on record, every delivery read before `taken` was held. A
    // session that changed without a stop on record (recycled, or its process killed) left no work running; the
    // runtime's own records tell the session, the router's deliveries do not.
    let running = false, start = -Infinity, session = null;
    for (const { event } of replay) {
      if (event.seq === taken.seq) break;
      if (event.type !== 'deliver' && event.session && event.session !== session) {
        if (session !== null) running = false;
        session = event.session;
      }
      if (END_TYPES.includes(event.type)) running = false;
      else if (event.type === 'input_dequeue' || (event.type === 'user_prompt_submit' && !running)) { running = true; start = event.at; }
    }
    // A delivery counts from its prompt when it has one, so the message that started the work is never held by it.
    // Each typed message the runtime took into a running turn left the queue first in, first out, possibly before
    // the router recorded its delivery; one taken with no delivery on record leaves the delivery queued after it.
    const prompted = promptTimes(rows);
    const queued = rows.filter(row => row.type === 'deliver' && (prompted.get(row) ?? row.at) > start)
      .map(row => ({ row, at: prompted.get(row) ?? row.at }));
    for (const removed of rows.filter(row => row.type === 'input_remove')) {
      const index = queued.findIndex(item => item.at <= removed.at);
      if (index >= 0) queued.splice(index, 1);
    }
    return queued.map(item => item.row).filter(row => row.at < from);
  }

  /**
   * The live area of a conversation: the group's current work (`working` is the header's reading), the main agent's
   * steps and marks since the last reply or the last quiet moment, the open subtasks, the latest unanswered user
   * message's progress, and the newest message this read looked at (`seenId`).
   */
  async activity(id, { tab = 'mine', subtask } = {}) {
    if (tab !== 'mine' || typeof id !== 'string' || !id.startsWith('g:')) throw fail('chat_activity_unsupported');
    const range = this.history._conversation(tab, id);
    const group = range.parameters.group;
    const { working, presence, header, ttlMs } = await this._group(range);
    const now = this.now();
    if (subtask !== undefined) {
      if (typeof subtask !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(subtask)) throw fail('invalid_chat_subtask');
      const agent = (working?.subagents?.ids ?? []).find(id => subtaskKey(id) === subtask);
      return { now, ...(agent ? this._subtask(group, agent, subtask, now) : { subtask: null, steps: [] }) };
    }
    // The header's reading: which subtasks it counts and whether the main agent works.
    const live = working ? new Set(working.subagents?.ids ?? []) : null;
    const busy = !!working?.on && (!!working.main || working.tools > 0);
    const { quiet, settled, stops } = this._quietSince(group, now, ttlMs, live);
    const { reply, messages } = this._unanswered(range);
    // A reply's time is whole seconds; work started within its second counts before it. Once the main agent stopped
    // after that reply, the reply's turn is over: work it takes up again (on a subtask's report, say) starts after it.
    // Only while it works: otherwise no steps are shown, and a message still waiting in C4 since before that stop counts
    // its wait on the page from the window's start, which stays at the reply.
    const resumed = busy && reply?.at != null && stops[0]?.at > reply.at + 1000 ? stops[0].at : -Infinity;
    const from = Math.max(reply?.at != null ? reply.at + 1000 : -Infinity, quiet ?? -Infinity, resumed, now - 24 * 3600_000);
    const read = this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata
      FROM runtime_events WHERE session_group=@group AND event_type IN (${STEP_TYPES.map(type => `'${type}'`).join(',')})
      AND timestamp >= @from AND timestamp <= @now
      AND NOT (event_type IN ('pre_tool_use','post_tool_use','post_tool_failure') AND (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.agent_id') END) IS NOT NULL)
      ORDER BY timestamp DESC, event_seq DESC LIMIT ${STEP_LIMIT}`, { group, from: iso(from - STOP_HOOK_LAG_MS), now: iso(now + 60_000) })
      .reverse().map(row => this._row(row));
    // A queued message taken as a turn ended can be timed before that stop: it counts just after it.
    const ordered = [...read, ...stops].sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
    const counted = inputAfterStop(ordered, { type: event => event.type, at: event => event.at, child: agentOf });
    const events = read.map(event => counted(event) === event.at ? event : { ...event, at: counted(event), recorded: event.at })
      .filter(event => event.at >= from).sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
    const ends = stops.filter(stop => stop.at >= from).map(stop => ({ at: stop.at, stopped: stop.type === 'dashboard_interrupt' }))
      .sort((a, b) => a.at - b.at);
    const built = buildSteps(events, { ends, now });
    // A message the runtime held while it worked is marked where it took it: at the first queued message taken.
    const taken = events.find(event => event.type === 'input_dequeue' && !agentOf(event));
    const held = taken ? this._held(group, taken, from, stops).map(event => ({ ...event, at: taken.at })) : [];
    const deliveries = [...held, ...events.filter(event => event.type === 'deliver')];
    const kind = this._markKinds(range, deliveries);
    const launches = subtaskLaunches(events);
    const marks = [
      ...deliveries.flatMap(event => { const mark = kind(event); return mark ? [{ kind: 'mark', ...mark, at: event.at }] : []; }),
      ...events.filter(event => event.type === 'subagent_start' && agentOf(event))
        .map(event => ({ kind: 'mark', mark: 'subtask', label: subtaskLabel(event, launches.get(agentOf(event))), at: event.at })),
    ];
    const steps = interleave(built.steps, marks);
    // The header's reading; the subtasks' agent ids on it are not enumerable and stay out of the response.
    return { now, from, working, presence, ...(header ? { header } : {}), steps,
      ...(built.truncated || read.length >= STEP_LIMIT ? { truncated: true } : {}),
      subtasks: this._subtasks(group, working?.subagents?.ids ?? [], now),
      awaiting: this._awaiting(group, messages, { stops, settled, busy, acted: Math.max(-Infinity, ...events
        .filter(event => !agentOf(event) && MAIN_ACTION_TYPES.includes(event.type) && event.type !== 'deliver').map(event => event.at)) }, now),
      seenId: Math.max(reply?.id ?? 0, messages.at(-1)?.id ?? 0) };
  }

  /** One running subtask's steps, read only while its row is open on the page; `key` is its page handle. */
  _subtask(group, id, key, now) {
    const start = this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata FROM runtime_events
      WHERE session_group=@group AND event_type='subagent_start' AND json_extract(metadata, '$.agent_id') = @id
      ORDER BY timestamp DESC, event_seq DESC LIMIT 1`, { group, id }).map(row => this._row(row))[0];
    if (!start) return { subtask: null, steps: [] };
    const events = this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata FROM runtime_events
      WHERE session_group=@group AND json_extract(metadata, '$.agent_id') = @id AND timestamp >= @from
      AND event_type IN ('pre_tool_use','post_tool_use','post_tool_failure','tool_call','tool_result','assistant_message','subagent_stop')
      ORDER BY timestamp DESC, event_seq DESC LIMIT ${STEP_LIMIT}`, { group, id, from: iso(start.at) }).reverse().map(row => this._row(row));
    const stop = events.find(event => event.type === 'subagent_stop');
    const built = buildSteps(events, { agent: id, ends: stop ? [{ at: stop.at, stopped: stop.meta.status === 'interrupted' }] : [], now });
    return { subtask: { id: key, start: start.at, end: stop?.at ?? null }, steps: built.steps,
      ...(built.truncated || events.length >= STEP_LIMIT ? { truncated: true } : {}) };
  }
}
