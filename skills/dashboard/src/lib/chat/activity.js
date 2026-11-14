import { createHash, randomUUID } from 'node:crypto';
import { END_TYPES, MAIN_ACTION_TYPES } from '../workbench/working.js';

/**
 * What the agent is doing right now, for a Dashboard conversation page.
 *
 * Runtime events are recorded per group, and a message taken from the runtime's own queue starts work without any
 * event of its own, so actions are never tied to the message that caused them. The page shows the group's current
 * work instead: the main agent's steps since the last reply in this conversation or since the group was last quiet
 * (whichever is later), a mark where a new input reached the session or a subtask began, and one row per subtask
 * that has not ended. Whether the group works at all comes from the same reading as the conversation header.
 * Steps carry only the one-line summaries the event store already holds: no tool output, no command text and no
 * thinking.
 */

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const STEP_TYPES = ['pre_tool_use', 'post_tool_use', 'post_tool_failure', 'tool_call', 'tool_result',
  'subagent_start', 'subagent_stop', 'assistant_message', 'deliver'];
// After the main agent stops, a message it took may still start work moments later (the runtime takes queued
// messages after the current turn without any event), and collectors read transcripts every 5 s. For this long after
// a stop, steps without an end keep running and a delivered message still counts as being thought about.
export const SETTLE_MS = 20_000;
// A delivered message that never led to a stop stops counting as being thought about after this long.
const PENDING_LIMIT_MS = 30 * 60_000;
const STEP_LIMIT = 1500, STEPS_SHOWN = 500, QUIET_LOOKBACK = 50, UNANSWERED_LIMIT = 50;
// How long before a subtask's start the call that launched it may be.
const LAUNCH_LEAD_MS = 10_000;
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
    if (event.type === 'assistant_message') {
      const text = plain(event.summary);
      if (text) steps.push({ kind: 'say', text, at: event.at });
      continue;
    }
    if (!['pre_tool_use', 'post_tool_use', 'post_tool_failure', 'tool_call', 'tool_result'].includes(event.type)) continue;
    if (event.runtime === 'codex' && ['pre_tool_use', 'post_tool_use', 'post_tool_failure'].includes(event.type)) continue;
    if (event.runtime !== 'codex' && ['tool_call', 'tool_result'].includes(event.type)) continue;
    const tool = toolName(meta);
    // A Claude subtask is shown as its own row, not as the call that launched it.
    if (event.runtime !== 'codex' && CLAUDE_AGENT_TOOLS.has(tool)) continue;
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
    if (event.runtime === 'codex' && (CODEX_AGENT_CONTROLS.has(tool) || Array.isArray(meta.wraps_agent_tools) && meta.wraps_agent_tools.length)) continue;
    const key = meta.tool_use_id ?? meta.call_id ?? '';
    if (!key) continue;
    if (['pre_tool_use', 'tool_call'].includes(event.type)) {
      if (open.has(key)) continue;
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
    if (step.kind === 'say' || step.end !== null) continue;
    const stop = ends.find(entry => entry.at >= step.start);
    if (stop !== undefined && now - stop.at >= SETTLE_MS) {
      step.status = stop.stopped ? 'stopped' : unread.has(step) ? 'done' : 'incomplete';
      step.end = stop.at;
    }
  }
  return { steps, truncated };
}

/**
 * Steps and marks in time order. A mark before the first step is dropped: the new input it stands for is already the
 * message the area sits under, or the reason the area appears at all.
 */
export function interleave(steps, marks) {
  const items = [...steps, ...marks].sort((a, b) => (a.start ?? a.at) - (b.start ?? b.at));
  const first = items.findIndex(item => item.kind !== 'mark');
  return first < 0 ? [] : items.slice(first);
}

/**
 * The `working(group)` reader for ChatActivity from the workbench snapshot (`getSnapshot`, `hotTtlMs`): the group's row,
 * the Origin row for the Origin group, so the conversation page and its header read the same thing.
 */
export function snapshotWorking(workbench, { origin }) {
  return async group => {
    const snapshot = await workbench.getSnapshot();
    const row = snapshot?.rows?.find(item => group === origin ? item.origin === true : item.sessionGroup === group);
    return row ? { working: row.working ?? null, presence: row.presence ?? null, ttlMs: workbench.hotTtlMs() } : null;
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
   * The latest stop of the main agent at which no subtask was running: the moment the group was last quiet. A subtask
   * that never reported its end counts as running only while its start is within `ttlMs`, the header's rule.
   */
  _quietSince(group, now, ttlMs) {
    const stops = this._stops(group, now);
    if (!stops.length) return { quiet: null, stops };
    const children = this._children(group, stops.at(-1).at - ttlMs, now);
    for (const stop of stops) {
      const open = new Map();
      for (const child of children) {
        if (child.at > stop.at) break;
        const id = agentOf(child);
        if (!id) continue;
        if (child.type === 'subagent_start') open.set(id, child.at); else open.delete(id);
      }
      if (![...open.values()].some(at => stop.at - at < ttlMs)) return { quiet: stop.at, stops };
    }
    // Every stop read had a subtask running: the oldest bounds the window only when older stops were left unread.
    return { quiet: stops.length >= QUIET_LOOKBACK ? stops.at(-1).at : null, stops };
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
   * delivered, and `handled` once the main agent stopped after it with no subtask running and did nothing more for
   * SETTLE_MS (`acted` is the main agent's latest action). Null when it is answered, or has waited or been thought
   * about past the pending limit.
   */
  _awaiting(group, unanswered, { stops, quiet, acted }, now) {
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
    const stop = stops.find(entry => entry.at >= at);
    if (stop && quiet !== null && quiet >= at && !(acted > quiet) && now - quiet >= SETTLE_MS) return { id: latest.id, state: 'handled', since: sent, delivered: at };
    if (!stop && now - at > PENDING_LIMIT_MS) return null;
    return { id: latest.id, state: 'thinking', since: sent, delivered: at };
  }

  /** The open subtasks the header counts, with their names, starts and how many steps each has taken so far. */
  _subtasks(group, ids, now) {
    if (!ids.length) return [];
    const starts = this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata FROM runtime_events
      WHERE session_group=@group AND event_type='subagent_start' AND json_extract(metadata, '$.agent_id') IN (SELECT value FROM json_each(@ids))
      AND timestamp <= @now ORDER BY timestamp, event_seq`, { group, ids: JSON.stringify(ids), now: iso(now) }).map(row => this._row(row));
    const latest = new Map();
    for (const start of starts) latest.set(agentOf(start), start);
    const first = Math.min(...[...latest.values()].map(start => start.at));
    const launchers = Number.isFinite(first) ? this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata
      FROM runtime_events WHERE session_group=@group AND event_type='pre_tool_use' AND json_extract(metadata, '$.tool_name') IN ('Agent','Task')
      AND timestamp >= @from AND timestamp <= @now ORDER BY timestamp, event_seq LIMIT ${STEP_LIMIT}`,
    { group, from: iso(first - LAUNCH_LEAD_MS), now: iso(now) }).map(row => this._row(row)) : [];
    const launches = subtaskLaunches([...launchers, ...starts].sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0)));
    const counts = new Map(this._events(`SELECT json_extract(metadata, '$.agent_id') AS agent, COUNT(*) AS steps FROM runtime_events
      WHERE session_group=@group AND event_type IN ('pre_tool_use','tool_call') AND json_extract(metadata, '$.agent_id') IN (SELECT value FROM json_each(@ids))
      AND timestamp >= @from AND timestamp <= @now GROUP BY agent`,
    { group, ids: JSON.stringify(ids), from: iso(Number.isFinite(first) ? first : now), now: iso(now) }).map(row => [row.agent, row.steps]));
    return ids.filter(id => latest.has(id)).map(id => {
      const start = latest.get(id);
      return { id: subtaskKey(id), label: subtaskLabel(start, launches.get(id)), start: start.at, steps: counts.get(id) ?? 0 };
    }).sort((a, b) => a.start - b.start);
  }

  async _group(range) {
    const group = range.parameters.group;
    let row = null;
    try { row = await this.working(group); } catch { row = null; }
    return { working: row?.working ?? null, presence: row?.presence ?? null, ttlMs: row?.ttlMs ?? 30 * 60_000 };
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
    const { working, presence, ttlMs } = await this._group(range);
    const now = this.now();
    if (subtask !== undefined) {
      if (typeof subtask !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(subtask)) throw fail('invalid_chat_subtask');
      const agent = (working?.subagents?.ids ?? []).find(id => subtaskKey(id) === subtask);
      return { now, ...(agent ? this._subtask(group, agent, subtask, now) : { subtask: null, steps: [] }) };
    }
    const { quiet, stops } = this._quietSince(group, now, ttlMs);
    const { reply, messages } = this._unanswered(range);
    // A reply's time is whole seconds; work started within its second counts before it.
    const from = Math.max(reply?.at != null ? reply.at + 1000 : -Infinity, quiet ?? -Infinity, now - 24 * 3600_000);
    const events = this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata
      FROM runtime_events WHERE session_group=@group AND event_type IN (${STEP_TYPES.map(type => `'${type}'`).join(',')})
      AND timestamp >= @from AND timestamp <= @now
      AND NOT (event_type IN ('pre_tool_use','post_tool_use','post_tool_failure') AND (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.agent_id') END) IS NOT NULL)
      ORDER BY timestamp DESC, event_seq DESC LIMIT ${STEP_LIMIT}`, { group, from: iso(from), now: iso(now + 60_000) })
      .reverse().map(row => this._row(row));
    const ends = stops.filter(stop => stop.at >= from).map(stop => ({ at: stop.at, stopped: stop.type === 'dashboard_interrupt' }))
      .sort((a, b) => a.at - b.at);
    const built = buildSteps(events, { ends, now });
    const deliveries = events.filter(event => event.type === 'deliver');
    const kind = this._markKinds(range, deliveries);
    const launches = subtaskLaunches(events);
    const marks = [
      ...deliveries.flatMap(event => { const mark = kind(event); return mark ? [{ kind: 'mark', ...mark, at: event.at }] : []; }),
      ...events.filter(event => event.type === 'subagent_start' && agentOf(event))
        .map(event => ({ kind: 'mark', mark: 'subtask', label: subtaskLabel(event, launches.get(agentOf(event))), at: event.at })),
    ];
    const steps = interleave(built.steps, marks);
    // The header's reading; the subtasks' agent ids on it are not enumerable and stay out of the response.
    return { now, from, working, presence, steps,
      ...(built.truncated || events.length >= STEP_LIMIT ? { truncated: true } : {}),
      subtasks: this._subtasks(group, working?.subagents?.ids ?? [], now),
      awaiting: this._awaiting(group, messages, { stops, quiet, acted: Math.max(-Infinity, ...events
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
