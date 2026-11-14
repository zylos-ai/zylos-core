import { element, icon } from './plain-text.js?v=106';
import { formatZoned } from './instance-zone.js?v=100';

/**
 * What the AI is doing right now, shown on the conversation page right below the latest message (a user message or a
 * reply). It never ties actions to the message that caused them: it shows the group's current steps, a mark where a
 * new input arrived or a subtask began, and one folded row per subtask that has not ended. It disappears when all
 * work is done; when the work ended without a reply, one line says so and leads to the group details. Activity nodes
 * live outside message content, so copying, searching, notifications and naming never see them.
 */

/** Elapsed time the way the activity area shows it: <1 s, N s, N min N s, N h N min. */
export function formatDuration(ms, t = key => key) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return t('chat.activity.lessThanSecond');
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return t('chat.activity.seconds').replace('{s}', String(seconds));
  if (seconds < 3600) return t('chat.activity.minutes').replace('{m}', String(Math.floor(seconds / 60))).replace('{s}', String(seconds % 60));
  return t('chat.activity.hours').replace('{h}', String(Math.floor(seconds / 3600))).replace('{m}', String(Math.floor(seconds % 3600 / 60)));
}

/** One line per step, in the page language; the label never carries a tool name or raw input. */
export function stepText(step, t = key => key) {
  const label = step.label ?? { key: 'tool' };
  if (label.key === 'described') return label.arg ?? t('chat.activity.label.runCommand');
  const text = t(`chat.activity.label.${label.key}`);
  return text.includes('{arg}') ? text.replace('{arg}', label.arg ?? '') : text;
}

/** A subtask's name: Memory Sync by what it does, otherwise the description it was started with. */
export function subtaskName(label, t = key => key) {
  if (label?.key === 'named' && label.arg) return label.arg;
  return t(label?.key === 'memorySync' ? 'chat.activity.subtask.memorySync' : 'chat.activity.subtask.plain');
}

const MARK_ICON = { message: 'msg', scheduled: 'clock', control: 'info', other: 'in', subtask: 'layers' };

/** A mark's text: what arrived, or which subtask began. */
export function markText(mark, t = key => key) {
  if (mark.mark === 'subtask') return t('chat.activity.mark.subtask').replace('{name}', subtaskName(mark.label, t));
  return t(`chat.activity.mark.${MARK_ICON[mark.mark] ? mark.mark : 'other'}`);
}

/**
 * What the live area shows for the loaded messages (internal relays left out) and the latest activity read, or null
 * when nothing is shown. `presence` is the header's reading of whether the session runs, and the area works exactly
 * when the header's reading says the main AI works (its `working`).
 * - before the session takes the latest user message: waking the session (or delivering it, when the session runs);
 * - once taken and until the AI does something: working, thinking;
 * - while the AI works: its steps, under the latest message whatever it is; a reply clears the steps before it;
 * - subtasks that have not ended: one row each, still shown when the main AI is idle (then nothing else is);
 * - all done: nothing, or one line under the latest user message when the work ended without a reply, from the first
 *   read after it settled (the page still reads often for a while, in case the runtime takes a queued message).
 * Elapsed time counts from the first unanswered user message of the current work while the area sits under a user
 * message, and is not shown under a reply.
 */
export function livePresentation(messages, activity, { presence = null } = {}) {
  const last = messages.at(-1);
  if (!activity || !last) return null;
  const working = activity.working;
  const main = !!working?.on && (!!working.main || working.tools > 0);
  const subtasks = Array.isArray(activity.subtasks) ? activity.subtasks : [];
  let awaiting = null;
  if (last.direction === 'in') {
    if (activity.awaiting?.id === last.id) awaiting = activity.awaiting;
    // Sent after the last read looked at the conversation: it is still on its way to the session.
    else if (last.id > (activity.seenId ?? 0)) awaiting = { id: last.id, state: 'queued', since: last.at ?? null };
  }
  const under = last.direction === 'in' ? 'in' : 'out';
  let since = null;
  if (under === 'in') {
    // From the first unanswered message sent since the read's window began (the group was quiet before it, so an
    // earlier one was already handled); when every unanswered message is older, from the window's start.
    const replied = messages.findLastIndex(row => row.direction !== 'in');
    const unanswered = messages.slice(replied + 1).filter(row => row.direction === 'in' && Number.isFinite(row.at));
    const from = Number.isFinite(activity.from) ? activity.from : -Infinity;
    // C4 times are whole seconds.
    const first = unanswered.find(row => row.at >= from - 1000);
    since = first ? first.at : unanswered.length ? Math.max(unanswered[0].at, from) : awaiting?.since ?? null;
  }
  // A reply the read has not seen yet clears the steps before it now, not only at the next read.
  const steps = Array.isArray(activity.steps) && !(under === 'out' && last.id > (activity.seenId ?? 0)) ? activity.steps : [];
  const base = { anchor: last.id, under, subtasks, truncated: activity.truncated === true };
  if (!main && awaiting?.state === 'queued') {
    const asleep = presence !== 'running';
    return { ...base, head: asleep ? 'waking' : 'sending', since: since ?? awaiting.since ?? null, steps: [],
      waiting: asleep ? 'starting' : 'queued' };
  }
  if (main) {
    const running = steps.some(step => step.kind === 'tool' && step.status === 'running');
    return { ...base, head: 'working', since, steps, waiting: running ? null : 'thinking' };
  }
  if (subtasks.length) return { ...base, head: null, since: null, steps: [], waiting: null };
  if (['settling', 'handled'].includes(awaiting?.state) && under === 'in') return { ...base, head: null, since: null, steps: [], waiting: null, handled: true, subtasks: [] };
  return null;
}

const STATUS_ICON = { running: 'loader', done: 'tick', failed: 'alert', incomplete: 'alert', stopped: 'stop' };

/**
 * The live area. `update(view, { now, open, details })` redraws it for a presentation from `livePresentation`;
 * `open` holds the subtasks whose rows are expanded, and `details` their steps once read. `onToggle(id)` opens or
 * closes a subtask row; `onDetails()` leads to the group details.
 */
export function createLiveArea({ document, t = key => key, locale, onToggle, onDetails }) {
  const node = (tag, text, cls) => element(document, tag, text, cls);
  const root = node('div', undefined, 'conversation-activity conversation-activity-live');
  root.setAttribute('aria-live', 'polite');
  const head = node('div', undefined, 'conversation-activity-head');
  const headText = node('span');
  head.append(icon(document, 'loader'), headText);
  const list = node('div', undefined, 'conversation-activity-steps');
  const rows = node('div', undefined, 'conversation-activity-subtasks');
  const note = node('div', undefined, 'conversation-activity-handled');
  let structure = null, times = [], subtaskNodes = new Map(), current = null;
  const clock = at => formatZoned(new Date(at), locale, { hour: '2-digit', minute: '2-digit' });

  function stepRow(step, into) {
    if (step.kind === 'mark') {
      const mark = node('div', undefined, 'conversation-activity-mark');
      mark.dataset.mark = step.mark;
      const pill = node('span');
      pill.append(icon(document, MARK_ICON[step.mark] ?? 'in'), node('span', `${markText(step, t)} · ${clock(step.at)}`));
      mark.append(pill);
      into.append(mark);
      return null;
    }
    const row = node('div', undefined, 'conversation-activity-step');
    row.dataset.status = step.status;
    const label = node('span', stepText(step, t), 'conversation-activity-label');
    label.title = label.textContent;
    const time = node('span', '', 'conversation-activity-time');
    row.append(icon(document, STATUS_ICON[step.status] ?? 'tick'), label, time);
    into.append(row);
    return { step, time };
  }
  function stepTime(step, now) {
    if (step.status === 'running') return t('chat.activity.running');
    const duration = formatDuration((step.end ?? now) - step.start, t);
    return step.status === 'failed' || step.status === 'incomplete' || step.status === 'stopped'
      ? `${t(`chat.activity.${step.status}`)} · ${duration}` : duration;
  }
  function waitingRow(key) {
    const row = node('div', undefined, 'conversation-activity-thinking');
    const dots = node('span', undefined, 'conversation-activity-dots');
    dots.append(node('i'), node('i'), node('i'));
    row.append(node('span', t(`chat.activity.${key}`)), dots);
    return row;
  }
  function subtaskRow(subtask) {
    const box = node('div', undefined, 'conversation-activity-subtask');
    const button = node('button', undefined, 'conversation-activity-subtask-row');
    button.type = 'button';
    button.dataset.action = 'toggleSubtask';
    const title = node('span', undefined, 'conversation-activity-subtask-title');
    const prefix = node('span', t('chat.activity.subtask.prefix'));
    const name = node('b');
    const rest = node('span');
    title.append(prefix, name, rest);
    button.append(icon(document, 'loader'), title, icon(document, 'chev'));
    button.addEventListener('click', () => onToggle?.(subtask.id));
    const steps = node('div', undefined, 'conversation-activity-steps');
    box.append(button, steps);
    return { box, button, name, rest, steps, shape: null, times: [] };
  }
  function updateSubtasks(view, { now, open, details }) {
    const ids = new Set(view.subtasks.map(subtask => subtask.id));
    for (const [id, item] of subtaskNodes) if (!ids.has(id)) { item.box.remove(); subtaskNodes.delete(id); }
    view.subtasks.forEach((subtask, index) => {
      let item = subtaskNodes.get(subtask.id);
      if (!item) { item = subtaskRow(subtask); subtaskNodes.set(subtask.id, item); }
      if (rows.children[index] !== item.box) rows.insertBefore(item.box, rows.children[index] ?? null);
      const expanded = open?.has(subtask.id) === true;
      if (expanded) item.box.dataset.open = ''; else delete item.box.dataset.open;
      item.button.setAttribute('aria-expanded', String(expanded));
      const name = subtaskName(subtask.label, t);
      if (item.name.textContent !== name) item.name.textContent = name;
      const rest = t('chat.activity.subtask.progress').replace('{duration}', formatDuration(now - subtask.start, t))
        .replace('{count}', String(subtask.steps ?? 0));
      if (item.rest.textContent !== rest) item.rest.textContent = rest;
      item.button.title = `${t('chat.activity.subtask.prefix')}${name}${rest}`;
      const detail = expanded ? details?.get(subtask.id) : null;
      const shape = JSON.stringify([expanded, detail ? detail.steps.map(step => [step.kind, step.status, step.label?.key, step.label?.arg]) : null]);
      if (shape !== item.shape) {
        item.shape = shape;
        item.times = [];
        item.steps.replaceChildren();
        if (expanded && !detail) item.steps.append(node('p', t('chat.activity.subtask.loading'), 'conversation-activity-more'));
        else if (expanded && !detail.steps.length) item.steps.append(node('p', t('chat.activity.subtask.empty'), 'conversation-activity-more'));
        else if (expanded) {
          if (detail.truncated) item.steps.append(node('p', t('chat.activity.truncated'), 'conversation-activity-more'));
          for (const step of detail.steps) { const row = stepRow(step, item.steps); if (row) item.times.push(row); }
        }
      }
      item.steps.hidden = !expanded;
      for (const { step, time } of item.times) { const text = stepTime(step, now); if (time.textContent !== text) time.textContent = text; }
    });
    rows.hidden = !view.subtasks.length;
  }
  function update(view, { now, open, details } = {}) {
    current = view;
    root.dataset.under = view.under;
    if (view.handled) {
      if (!note.children.length) {
        note.append(icon(document, 'check'), node('span', t('chat.activity.handled')));
        if (onDetails) {
          const link = node('button', t('chat.activity.handledLink'), 'wb-link-btn conversation-activity-details');
          link.type = 'button';
          link.dataset.action = 'openGroupDetails';
          link.append(icon(document, 'out'));
          link.addEventListener('click', () => onDetails());
          note.append(node('span', '·'), link);
        }
      }
      root.replaceChildren(note);
      root.dataset.state = 'handled';
      structure = null;
      return;
    }
    root.dataset.state = view.head ?? 'subtasks';
    const parts = view.head ? [head, list, rows] : [rows];
    if (root.children.length !== parts.length || parts.some((part, index) => root.children[index] !== part)) root.replaceChildren(...parts);
    if (view.head) {
      const state = t(`chat.activity.${view.head}`);
      const text = Number.isFinite(view.since) ? t('chat.activity.elapsed').replace('{state}', state).replace('{time}', formatDuration(now - view.since, t)) : state;
      if (headText.textContent !== text) headText.textContent = text;
      const shape = JSON.stringify([view.waiting, view.truncated, view.steps.map(step => step.kind === 'mark' ? ['mark', step.mark, step.at, step.label?.arg]
        : [step.kind, step.status, step.label?.key, step.label?.arg])]);
      if (shape !== structure) {
        structure = shape;
        times = [];
        list.replaceChildren();
        if (view.truncated) list.append(node('p', t('chat.activity.truncated'), 'conversation-activity-more'));
        for (const step of view.steps) { const row = stepRow(step, list); if (row) times.push(row); }
        if (view.waiting) list.append(waitingRow(view.waiting));
      }
      for (const { step, time } of times) { const text = stepTime(step, now); if (time.textContent !== text) time.textContent = text; }
    }
    updateSubtasks(view, { now, open, details });
  }
  return { node: root, update, get view() { return current; } };
}
