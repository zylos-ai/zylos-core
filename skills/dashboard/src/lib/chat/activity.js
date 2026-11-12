import { randomUUID } from 'node:crypto';

/**
 * What the agent did for a Dashboard conversation's messages, read from the group's runtime events.
 *
 * Runtime events are recorded per group, not per message. A visible inbound message is tied to the work it caused
 * through the router's delivery event (it carries the message id), then to the runtime turn that delivery started:
 * a turn opens on a submitted prompt and closes on stop, turn completion, a runtime failure (StopFailure) or a
 * Dashboard interrupt. Other inputs reach the same group (scheduled tasks, messages from other groups, controls);
 * their deliveries own their turns and are never shown. Steps carry only the one-line summaries the event store
 * already holds: no tool output, no command text and no thinking.
 */

const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const TURN_TYPES = ['deliver', 'user_prompt_submit', 'stop', 'turn_complete', 'dashboard_interrupt', 'runtime_health:stop_failure'];
const END_TYPES = ['stop', 'turn_complete', 'dashboard_interrupt', 'runtime_health:stop_failure'];
const STEP_TYPES = ['pre_tool_use', 'post_tool_use', 'post_tool_failure', 'tool_call', 'tool_result',
  'subagent_start', 'subagent_stop', 'assistant_message'];
// The router confirms a delivery after the runtime has already taken the prompt, so a turn that opened shortly
// before its delivery record still belongs to that delivery.
const DELIVERY_LEAD_MS = 10_000;
// Messages typed while the agent is busy may be taken as a fresh turn right after the current one stops.
const CONTINUATION_GAP_MS = 10_000;
// After a round ends its last events can still be on their way: collectors read rollouts and transcripts every
// 5 s, and a queued message may start a continuation turn up to CONTINUATION_GAP_MS later. For this long after the
// end the round is reported as settling: the page keeps reading it and unfinished steps are not yet given up.
const SETTLE_MS = CONTINUATION_GAP_MS + 10_000;
const BOUNDARY_PAGE = 1000, BOUNDARY_PAGES = 10, STEP_LIMIT = 1500, STEPS_PER_ROUND = 500;
// A delivery that never produced a turn stops being polled for after this long.
const PENDING_LIMIT_MS = 30 * 60_000;
// Calls that manage subagents rather than do work (both multi-agent tool generations, including an `exec` that
// calls them from code mode); the subagent itself is a step. A code-mode `wait` with a cell id is not one of them: it
// resumes a yielded `exec`, whose step it ends.
const CODEX_AGENT_CONTROLS = new Set(['spawn_agent', 'send_input', 'wait_agent', 'close_agent', 'resume_agent',
  'send_message', 'list_agents', 'followup_task', 'interrupt_agent', 'wait', 'sleep']);
const CODEX_COMMANDS = new Set(['exec', 'exec_command', 'shell', 'local_shell', 'container.exec', 'write_stdin', 'unified_exec']);

const toolName = meta => typeof meta.tool_name === 'string' ? meta.tool_name.replace(/^functions\./, '') : '';
const iso = ms => new Date(ms).toISOString();
const ms = value => { const time = Date.parse(value); return Number.isFinite(time) ? time : null; };
/** C4 stores UTC seconds as `YYYY-MM-DD HH:MM:SS`. */
const c4Time = value => typeof value === 'string' ? ms(value.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z')) : null;
const parse = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
const shortPath = value => String(value).split('/').filter(Boolean).slice(-3).join('/');
const plain = value => typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;

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
  if (tool === 'Agent' || tool === 'Task') return { key: 'subagent', ...(detail ? { arg: detail } : {}) };
  return { key: 'tool' };
}

/** Records a Dashboard interrupt so the interrupted round can be shown as stopped. */
export function recordGroupInterrupt(store, { sessionGroup, runId = null, sessionId = null, controlId = null, at = Date.now() } = {}) {
  if (!store || typeof sessionGroup !== 'string' || !sessionGroup) return null;
  const id = randomUUID();
  return store.insertEvent({ id, ingest_id: `dashboard-interrupt-${id}`, timestamp: iso(at), runtime: 'unknown',
    session_id: sessionId, session_group: sessionGroup, run_id: runId, event_type: 'dashboard_interrupt',
    category: 'turn', summary: 'Interrupted from Dashboard', metadata: { control_id: controlId }, source: 'dashboard' });
}

/**
 * Turns from prompt/stop events, in time order. No thread filter is applied: a Claude subagent reports through
 * subagent hook events, and on real Codex 0.167.0 data a subagent's thread writes no prompt or end into its parent's
 * group.
 */
export function buildTurns(events) {
  const turns = [];
  let open = null;
  for (const event of events) {
    if (event.type === 'user_prompt_submit') {
      if (!open) { open = { start: event.at, end: null, stopped: false, sessions: new Set(), owner: false, round: null }; turns.push(open); }
      if (event.session) open.sessions.add(event.session);
    } else if (open && END_TYPES.includes(event.type)) {
      open.end = event.at;
      open.stopped = event.type === 'dashboard_interrupt';
      open = null;
    }
  }
  return turns;
}

/**
 * Rounds of visible messages, from deliveries and turns in time order:
 * - a delivery owns the turn it started (the first turn after it, or one that opened just before its record);
 * - a visible message delivered during a turn joins that turn's visible round, or opens one from its delivery
 *   when the turn belongs to something else;
 * - a visible message delivered before a turn another visible message already owns joins that round;
 * - a round takes the next turn when one of its messages arrived mid-turn and that turn opened right after the
 *   round's turn stopped without a delivery of its own (the runtime took the queued message as a new turn).
 * A visible message whose delivery has no turn yet makes a round without a start (still waiting).
 */
export function buildRounds(boundaries, visible) {
  const turns = buildTurns(boundaries);
  const rounds = [], byMessage = new Map();
  let waiting = null;
  const open = (delivery, start, owned) => {
    const round = { messages: [delivery.message], delivered: delivery.at, start, turns: owned, waiting: false };
    rounds.push(round); byMessage.set(delivery.message, round);
    return round;
  };
  const join = (round, delivery, midTurn) => {
    round.messages.push(delivery.message); byMessage.set(delivery.message, round);
    if (midTurn) round.waiting = true;
  };
  for (const delivery of boundaries) {
    if (delivery.type !== 'deliver') continue;
    const shown = delivery.message !== null && visible.has(delivery.message);
    const current = turns.find(turn => turn.start <= delivery.at && (turn.end === null || delivery.at <= turn.end));
    if (current && !current.owner && delivery.at - current.start <= DELIVERY_LEAD_MS) {
      current.owner = true;
      if (shown) current.round = open(delivery, current.start, [current]);
      continue;
    }
    if (current) {
      current.owner = true;
      if (!shown) continue;
      if (current.round) join(current.round, delivery, true);
      else current.round = open(delivery, delivery.at, [current]);
      continue;
    }
    const next = turns.find(turn => turn.start > delivery.at);
    if (!next) {
      if (!shown) continue;
      if (waiting) join(waiting, delivery, false);
      else waiting = open(delivery, null, []);
      continue;
    }
    if (!next.owner) {
      next.owner = true;
      if (shown) next.round = open(delivery, next.start, [next]);
    } else if (shown) {
      if (next.round) join(next.round, delivery, false);
      else next.round = open(delivery, next.start, [next]);
    }
  }
  for (const round of rounds) {
    let last = round.turns.at(-1);
    while (round.waiting && last && last.end !== null && !last.stopped) {
      const next = turns[turns.indexOf(last) + 1];
      if (!next || next.owner || next.start - last.end > CONTINUATION_GAP_MS) break;
      next.owner = true; next.round = round; round.turns.push(next); round.waiting = false; last = next;
    }
  }
  return { rounds, byMessage };
}

/**
 * Steps of one round from its events (time order), keyed so a start and its end become one step. When there are
 * more than a round can show, the newest are kept. While the round is settling, a step without an end is still
 * running rather than unfinished: its end may not have been collected yet.
 */
export function buildSteps(events, round, { settling = false } = {}) {
  const sessions = new Set(round.turns.flatMap(turn => [...turn.sessions]));
  const end = round.turns.at(-1)?.end ?? null;
  let steps = [], truncated = false;
  const open = new Map(), cells = new Map();
  const add = item => { steps.push(item); return true; };
  for (const event of events) {
    if (event.at < round.start || (end !== null && event.at > end)) continue;
    if (sessions.size && event.session && !sessions.has(event.session)) continue;
    const meta = event.meta;
    if (event.type === 'assistant_message') {
      const text = plain(event.summary);
      if (text) add({ kind: 'say', text, at: event.at });
      continue;
    }
    if (event.runtime === 'codex' && ['pre_tool_use', 'post_tool_use', 'post_tool_failure'].includes(event.type)) continue;
    if (event.runtime !== 'codex' && ['tool_call', 'tool_result', 'subagent_start', 'subagent_stop'].includes(event.type)) continue;
    if (meta.agent_id && ['pre_tool_use', 'post_tool_use', 'post_tool_failure'].includes(event.type)) continue;
    const tool = toolName(meta);
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
    if (['tool_call', 'tool_result'].includes(event.type)
      && (CODEX_AGENT_CONTROLS.has(tool) || Array.isArray(meta.wraps_agent_tools) && meta.wraps_agent_tools.length)) continue;
    const key = event.type.startsWith('subagent_') ? `agent:${meta.agent_id}`
      : `tool:${meta.tool_use_id ?? meta.call_id ?? ''}`;
    if (key.endsWith(':') || key === 'agent:undefined') continue;
    if (['pre_tool_use', 'tool_call', 'subagent_start'].includes(event.type)) {
      if (open.has(key)) continue;
      // A Codex subagent is named only as a subtask: its description is the message it was given.
      const label = event.type === 'subagent_start' ? { key: 'subagent' } : stepLabel(event);
      const step = { kind: label.key === 'subagent' ? 'subagent' : 'tool', label, status: 'running', start: event.at, end: null };
      if (event.type === 'subagent_start') Object.defineProperty(step, 'codexSubagent', { value: true });
      if (add(step)) open.set(key, step);
    } else {
      const step = open.get(key);
      if (!step || step.end !== null) continue;
      // An `exec` that yielded while its script still runs goes on until a `wait` on its cell sees it finish.
      if (event.type === 'tool_result' && meta.cell_running && typeof meta.cell_id === 'string') { cells.set(meta.cell_id, step); continue; }
      step.end = event.at;
      step.status = event.type === 'post_tool_failure' || meta.outcome === 'failed' ? 'failed'
        : event.type === 'subagent_stop' && meta.status === 'interrupted' ? 'stopped' : 'done';
    }
  }
  if (steps.length > STEPS_PER_ROUND) { steps = steps.slice(-STEPS_PER_ROUND); truncated = true; }
  const stopped = round.turns.at(-1)?.stopped === true;
  // Code-mode commands that yielded and that no `wait` on their cell saw finish (the model may poll in a new `exec`).
  const unread = new Set(cells.values());
  for (const step of steps) {
    if (step.kind === 'say' || step.end !== null) continue;
    // A Codex subagent's end is recorded only when the parent waits for it or is told it finished, and a yielded
    // command's only when a `wait` on its cell reads it; when that was not seen, it is taken to have ended with the round.
    if (end !== null && !settling) {
      step.status = stopped ? 'stopped' : step.codexSubagent || unread.has(step) ? 'done' : 'incomplete';
      step.end = end;
    }
    else step.status = 'running';
  }
  return { steps, truncated };
}

/** Splits a round's steps at the replies sent during it; each part runs from the previous reply to its own. */
export function buildSegments(steps, replies, { start, end }) {
  const segments = [];
  let from = start, index = 0;
  for (const reply of replies) {
    // Reply times are whole seconds; a step started within the reply's second counts before it.
    const cut = reply.at + 1000;
    const own = [];
    while (index < steps.length && (steps[index].start ?? steps[index].at) < cut) own.push(steps[index++]);
    segments.push({ replyId: reply.id, start: from, end: Math.max(from, reply.at), steps: own });
    from = Math.max(from, reply.at);
  }
  segments.push({ replyId: null, start: from, end, steps: steps.slice(index) });
  return segments;
}

export class ChatActivity {
  constructor({ history, store, now = Date.now }) {
    this.history = history;
    this.store = store;
    this.now = now;
  }

  _events(sql, parameters) {
    try { return this.store.db.prepare(sql).all(parameters); }
    catch { throw fail('chat_activity_unavailable', 502); }
  }

  _row(row) {
    const meta = parse(row.metadata);
    return { type: row.event_type, at: ms(row.timestamp), session: row.session_id ?? null, runtime: row.runtime,
      summary: row.summary, meta, seq: row.event_seq,
      message: row.event_type === 'deliver' && Number.isSafeInteger(Number(meta.conversation_id)) && Number(meta.conversation_id) > 0
        ? Number(meta.conversation_id) : null };
  }

  /** Turn boundaries and deliveries of a group from a time on, in time order, a bounded number of pages. */
  _boundaries(group, from, enough) {
    const rows = [];
    let cursor = { at: iso(from), seq: -1 };
    for (let page = 0; page < BOUNDARY_PAGES; page++) {
      const batch = this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata
        FROM runtime_events WHERE session_group=@group AND event_type IN (${TURN_TYPES.map(type => `'${type}'`).join(',')})
        AND (timestamp > @at OR (timestamp = @at AND event_seq > @seq))
        ORDER BY timestamp, event_seq LIMIT ${BOUNDARY_PAGE}`, { group, ...cursor });
      rows.push(...batch.map(row => this._row(row)));
      if (batch.length < BOUNDARY_PAGE) return { rows, complete: true };
      if (enough(rows)) return { rows, complete: false };
      const last = batch.at(-1);
      cursor = { at: last.timestamp, seq: last.event_seq };
    }
    return { rows, complete: false };
  }

  /**
   * A Dashboard interrupt ends a turn only once C4 has delivered its Escape to the session, and it ends it at the
   * delivery time; an interrupt still queued, failed or expired leaves the turn running.
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
      } catch { /* Unknown delivery: the interrupt does not end the turn. */ }
    }
    return rows.flatMap(row => {
      if (row.type !== 'dashboard_interrupt') return [row];
      const control = controls.get(Number(row.meta.control_id));
      if (control?.status !== 'done') return [];
      const delivered = Number(control.updated_at) * 1000;
      return [{ ...row, at: Number.isFinite(delivered) ? Math.max(row.at, delivered) : row.at }];
    }).sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
  }

  /**
   * Rounds around one message: boundaries from the last moment the group was idle before it (so a turn already
   * running then is known), read until the later wanted messages are seen and the last turn has ended, at most a
   * bounded number of pages. Each message far from the previous scan gets its own scan, so messages days apart
   * never depend on one long read.
   */
  _scan(range, group, sent, wanted) {
    const before = iso(sent - DELIVERY_LEAD_MS);
    const idle = this._events(`SELECT timestamp FROM runtime_events WHERE session_group=@group
      AND event_type IN ('stop','turn_complete','runtime_health:stop_failure') AND timestamp < @at
      ORDER BY timestamp DESC, event_seq DESC LIMIT 1`, { group, at: before })[0];
    const from = Math.min(sent - DELIVERY_LEAD_MS, idle ? ms(idle.timestamp) : sent - DELIVERY_LEAD_MS);
    const { rows, complete } = this._boundaries(group, from, rows => {
      const seen = new Set(rows.filter(row => wanted.has(row.message)).map(row => row.message));
      if (seen.size < wanted.size) return false;
      const turns = buildTurns(rows);
      return turns.length > 0 && turns.at(-1).end !== null;
    });
    const boundaries = this._deliveredInterrupts(rows);
    const delivered = [...new Set(boundaries.map(row => row.message).filter(value => value !== null))];
    const visible = new Set(delivered.length ? this.history._query(`SELECT c.id FROM conversations c
      WHERE ${range.where} AND c.direction='in' AND c.id IN (${delivered.map(value => Number(value)).join(',')})`,
    range.parameters).map(row => row.id) : []);
    return { ...buildRounds(boundaries, visible), complete };
  }

  activity(id, { tab = 'mine', ids } = {}) {
    if (tab !== 'mine' || typeof id !== 'string' || !id.startsWith('g:')) throw fail('chat_activity_unsupported');
    const range = this.history._conversation(tab, id);
    const group = range.parameters.group;
    const requested = this.history._rowsByIds(range, this.history._messageIds(ids), 'c.id,c.direction,c.timestamp,c.status');
    const now = this.now();
    const sentAt = row => c4Time(row.timestamp) ?? now;
    const inbound = requested.filter(row => row.direction === 'in').sort((a, b) => sentAt(a) - sentAt(b) || a.id - b.id);
    const items = requested.filter(row => row.direction !== 'in').map(row => ({ id: row.id, state: 'none' }));
    if (!inbound.length) return { now, items, rounds: [] };
    const shown = new Map();
    let scan = null;
    for (const [index, row] of inbound.entries()) {
      // A scan answers for a message when it saw it, or when it read everything up to now; otherwise the message
      // gets a scan of its own.
      let round = scan?.byMessage.get(row.id);
      const settled = round && (scan.complete || round.start === null || round.turns.at(-1)?.end !== null);
      if (!settled && !scan?.complete) {
        scan = this._scan(range, group, sentAt(row), new Set(inbound.slice(index).map(entry => entry.id)));
        round = scan.byMessage.get(row.id);
      }
      if (!round) {
        items.push({ id: row.id, state: this._undelivered(group, row, now) });
        continue;
      }
      if (round.start === null) {
        items.push({ id: row.id, state: now - round.delivered > PENDING_LIMIT_MS ? 'none' : 'pending' });
        continue;
      }
      const key = this._key(round);
      items.push({ id: row.id, state: 'round', round: key });
      if (!shown.has(key)) shown.set(key, round);
    }
    const result = [];
    for (const round of shown.values()) result.push(this._round(range, group, round, now));
    return { now, items, rounds: result };
  }

  /**
   * A visible message with no delivery record yet. While C4 still queues it (for example waiting for a free
   * session) or the router has already logged anything about it, its round can still start; it has no activity
   * once it left the queue and either the router never mentioned it within two minutes or no turn followed within
   * the pending limit, so the page stops asking.
   */
  _undelivered(group, row, now) {
    if (['pending', 'running'].includes(row.status)) return 'pending';
    const sent = c4Time(row.timestamp) ?? now;
    if (now - sent <= 2 * 60_000) return 'pending';
    if (now - sent > PENDING_LIMIT_MS) return 'none';
    const routed = this._events(`SELECT 1 FROM runtime_events WHERE session_group=@group AND timestamp >= @from
      AND json_extract(metadata, '$.conversation_id') = @id LIMIT 1`, { group, from: iso(sent - DELIVERY_LEAD_MS), id: row.id });
    return routed.length ? 'pending' : 'none';
  }

  _key(round) { return `${round.messages[0]}`; }

  /**
   * One round's steps and replies. Events that never become steps (subagents' own tool calls, Codex hook copies of
   * rollout calls) are left out before the limit is applied, and the newest events are kept, so a long round still
   * shows its latest steps; the part that lost older steps says so.
   */
  _round(range, group, round, now) {
    const end = round.turns.at(-1)?.end ?? null;
    const settling = end !== null && now - end < SETTLE_MS;
    const events = this._events(`SELECT event_seq, timestamp, runtime, session_id, event_type, summary, metadata
      FROM runtime_events WHERE session_group=@group AND event_type IN (${STEP_TYPES.map(type => `'${type}'`).join(',')})
      AND timestamp >= @start AND timestamp <= @end
      AND NOT (event_type IN ('pre_tool_use','post_tool_use','post_tool_failure') AND (COALESCE(runtime,'')='codex'
        OR (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.agent_id') END) IS NOT NULL))
      AND NOT (COALESCE(runtime,'')<>'codex' AND event_type IN ('tool_call','tool_result','subagent_start','subagent_stop'))
      ORDER BY timestamp DESC, event_seq DESC LIMIT ${STEP_LIMIT}`,
    { group, start: iso(round.start), end: iso(end ?? now + 60_000) }).reverse().map(row => this._row(row));
    const built = buildSteps(events, round, { settling });
    const replies = this.history._query(`SELECT c.id, c.timestamp FROM conversations c WHERE ${range.where}
      AND c.direction='out' AND julianday(c.timestamp) >= julianday(@from) AND (@to IS NULL OR julianday(c.timestamp) <= julianday(@to))
      ORDER BY c.id LIMIT 100`, { ...range.parameters, from: iso(Math.floor(round.start / 1000) * 1000), to: end === null ? null : iso(end) })
      .map(row => ({ id: row.id, at: c4Time(row.timestamp) })).filter(row => row.at !== null);
    const segments = buildSegments(built.steps, replies, { start: round.start, end });
    if (built.truncated || events.length >= STEP_LIMIT) {
      const first = segments.find(segment => segment.steps.length) ?? segments[0];
      first.truncated = true;
    }
    return { key: this._key(round), messageIds: round.messages, start: round.start, end,
      state: end === null ? 'running' : round.turns.at(-1).stopped ? 'stopped' : 'done',
      ...(settling ? { settling: true } : {}), segments };
  }
}
