import { element, icon } from './plain-text.js?v=104';

/**
 * The agent's activity on the conversation page: tool steps, words said along the way and subtasks, folded into one
 * line above each reply, below it for follow-up work, and open while the agent works. Activity nodes live outside message content, so copying,
 * searching, notifications and naming never see them.
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

/** Tool calls and subtasks count as steps; words said along the way and thinking do not. */
export function stepCount(segment) {
  return segment.steps.filter(step => step.kind !== 'say').length;
}

/** One line per step, in the page language; the label never carries a tool name or raw input. */
export function stepText(step, t = key => key) {
  const label = step.label ?? { key: 'tool' };
  if (label.key === 'described') return label.arg ?? t('chat.activity.label.runCommand');
  if (label.key === 'subagent' && !label.arg) return t('chat.activity.label.subagentPlain');
  const text = t(`chat.activity.label.${label.key}`);
  return text.includes('{arg}') ? text.replace('{arg}', label.arg ?? '') : text;
}

/**
 * Where each activity part goes. A part that ends with a reply folds above that reply when it has steps; the part
 * after the last reply is the live area while the round runs (shown before the first reply even with no steps, and
 * after a reply once something happens). Finished trailing steps fold below their preceding loaded reply; without
 * that reply they retain the separate area after the round's last loaded message.
 * The live area sits under the latest user message, including one sent moments ago that is still waiting to be routed.
 */
export function activityPlacement(messages, activity) {
  const loaded = new Set(messages.map(row => row.id));
  const loadedReplies = new Set(messages.filter(row => row.direction === 'out').map(row => row.id));
  const folded = new Map(), afterReply = new Map(), trailing = [];
  if (!activity) return { folded, afterReply, trailing };
  const seen = new Set();
  for (const row of messages) {
    if (row.direction !== 'in') continue;
    const item = activity.items.get(row.id);
    if (item?.state !== 'round' || seen.has(item.round)) continue;
    seen.add(item.round);
    const round = activity.rounds.get(item.round);
    if (!round) continue;
    const anchors = [...round.messageIds, ...round.segments.map(part => part.replyId).filter(id => id !== null)].filter(id => loaded.has(id));
    if (!anchors.length) continue;
    let anchor = Math.max(...anchors);
    // While the agent works, a message just sent is not yet known to belong to this round (that takes one refresh after
    // it reaches the session); the live area already moves under it so it always sits below the latest user message.
    if (round.state === 'running') for (const later of messages) {
      if (later.direction !== 'in' || later.id <= anchor) continue;
      const state = activity.items.get(later.id)?.state;
      if (state === undefined || state === 'pending') anchor = later.id;
    }
    let replies = 0, precedingReply = null;
    for (const segment of round.segments) {
      const key = `${round.key}:${segment.replyId ?? 'tail'}`;
      if (segment.replyId !== null) {
        replies++;
        precedingReply = segment.replyId;
        if (loaded.has(segment.replyId) && stepCount(segment)) {
          if (!folded.has(segment.replyId)) folded.set(segment.replyId, []);
          folded.get(segment.replyId).push({ key, round, segment, live: false });
        }
        continue;
      }
      if (round.state === 'running') {
        if (!replies || segment.steps.length) trailing.push({ key, round, segment, live: true, anchor });
      } else if (stepCount(segment)) {
        if (precedingReply !== null && loadedReplies.has(precedingReply)) {
          if (!afterReply.has(precedingReply)) afterReply.set(precedingReply, []);
          afterReply.get(precedingReply).push({ key, round, segment, live: false, afterReply: true, replyId: precedingReply });
        } else trailing.push({ key, round, segment, live: false, anchor });
      }
    }
  }
  return { folded, afterReply, trailing };
}

const STATUS_ICON = { running: 'loader', done: 'check', failed: 'alert', incomplete: 'alert', stopped: 'stop' };

/** One activity area. `update` patches it for a placement entry at a given server time. */
export function createActivityArea({ document, t = key => key, onToggle }) {
  const node = (tag, text, cls) => element(document, tag, text, cls);
  const root = node('div', undefined, 'conversation-activity');
  let head, headText, chevron, list, structure = null, rows = [], current = null;
  function build(live) {
    head = node(live ? 'div' : 'button', undefined, 'conversation-activity-head');
    headText = node('span');
    head.append(headText);
    if (!live) {
      head.type = 'button';
      head.dataset.action = 'toggleActivity';
      chevron = icon(document, 'chev');
      head.append(chevron);
      head.addEventListener('click', () => current && onToggle?.(current.key));
    } else chevron = null;
    list = node('div', undefined, 'conversation-activity-steps');
    root.replaceChildren(head, list);
    root.classList.toggle('conversation-activity-live', live);
  }
  function update(entry, { open, now }) {
    current = entry;
    const live = entry.live;
    if (!head || root.classList.contains('conversation-activity-live') !== live) { build(live); structure = null; }
    const { segment, round } = entry;
    const expanded = live || open;
    root.classList.toggle('conversation-activity-after-reply', entry.afterReply === true);
    if (expanded) root.dataset.open = ''; else delete root.dataset.open;
    root.dataset.activityKey = entry.key;
    const elapsed = (segment.end ?? now) - segment.start;
    const count = stepCount(segment);
    // A part that lost its oldest steps to the per-round limit counts as "N+" and says so at the top of its list.
    const countText = segment.truncated ? `${count}+` : String(count);
    const steps = t(count === 1 && !segment.truncated ? 'chat.activity.oneStep' : 'chat.activity.steps').replace('{count}', countText);
    headText.textContent = entry.afterReply
      ? t('chat.activity.afterReply').replace('{duration}', formatDuration(elapsed, t)).replace('{steps}', countText)
      : t(live ? 'chat.activity.working' : 'chat.activity.worked').replace('{time}', formatDuration(elapsed, t)).replace('{steps}', steps);
    if (!live) {
      head.setAttribute('aria-expanded', String(expanded));
      head.setAttribute('aria-label', `${headText.textContent} · ${t(expanded ? 'chat.activity.hide' : 'chat.activity.show')}`);
    }
    list.hidden = !expanded;
    const thinking = live && round.state === 'running' && !segment.steps.some(step => step.status === 'running');
    const shape = JSON.stringify([expanded, thinking, segment.truncated === true, segment.steps.map(step => step.kind === 'say' ? ['say', step.text]
      : [step.kind, step.status, step.label?.key, step.label?.arg])]);
    if (shape !== structure) {
      structure = shape;
      rows = [];
      const children = [];
      if (expanded && segment.truncated) children.push(node('p', t('chat.activity.truncated'), 'conversation-activity-more'));
      if (expanded) for (const step of segment.steps) {
        if (step.kind === 'say') { children.push(node('p', step.text, 'conversation-activity-say')); rows.push(null); continue; }
        const row = node('div', undefined, 'conversation-activity-step');
        row.dataset.status = step.status;
        const symbol = step.kind === 'subagent' && step.status === 'done' ? 'layers' : STATUS_ICON[step.status] ?? 'check';
        const label = node('span', stepText(step, t), 'conversation-activity-label');
        label.title = label.textContent;
        const time = node('span', '', 'conversation-activity-time');
        row.append(icon(document, symbol), label, time);
        children.push(row); rows.push(time);
      }
      if (expanded && thinking) {
        const row = node('div', undefined, 'conversation-activity-thinking');
        const dots = node('span', undefined, 'conversation-activity-dots');
        dots.append(node('i'), node('i'), node('i'));
        row.append(dots, node('span', t('chat.activity.thinking')));
        children.push(row);
      }
      list.replaceChildren(...children);
    }
    segment.steps.forEach((step, index) => {
      const time = rows[index];
      if (!time) return;
      // A step still open in a part that already ended (the round is settling) counts no further than its part.
      const until = step.end ?? (segment.end != null ? Math.min(now, segment.end) : now);
      const duration = formatDuration(until - step.start, t);
      const text = step.status === 'failed' || step.status === 'incomplete' ? `${t('chat.activity.failed')} · ${duration}`
        : step.status === 'stopped' ? `${t('chat.activity.stopped')} · ${duration}` : duration;
      if (time.textContent !== text) time.textContent = text;
    });
  }
  return { node: root, update };
}
