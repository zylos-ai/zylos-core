import { formatZoned } from './instance-zone.js?v=100';

export function workingDuration(since, { now = Date.now(), t = key => key } = {}) {
  if (!Number.isFinite(since)) return null;
  const minutes = Math.floor(Math.max(0, now - since) / 60000);
  if (minutes < 1) return t('chat.working.lessMinute');
  const minuteText = count => t(count === 1 ? 'chat.working.minute' : 'chat.working.minutes', { count });
  if (minutes < 60) return minuteText(minutes);
  const hours = Math.floor(minutes / 60);
  return [t(hours === 1 ? 'chat.working.hour' : 'chat.working.hours', { count: hours }), minuteText(minutes % 60)].join(' ');
}

function compactDuration(since, { now, t }) {
  if (!Number.isFinite(since)) return null;
  const minutes = Math.floor(Math.max(0, now - since) / 60000);
  if (minutes < 1) return t('chat.working.mobile.lessMinute');
  if (minutes < 60) return t('chat.working.mobile.minutes', { count: minutes });
  return t('chat.working.mobile.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** Shared caption parts; compact wording belongs only to the phone working pill.
 * `scheduled` is true only for an Origin turn handed off by the scheduler. */
export function workingParts(working, { now = Date.now(), t = key => key, scheduled = false, compact = false } = {}) {
  if (!working) return { main: '', duration: null, children: null };
  if (!working.on) return { main: t('wb.state.idle'), duration: null, children: null };
  const prefix = compact ? 'chat.working.mobile.' : 'chat.working.';
  const children = working.subagents?.count > 0
    ? t(prefix + (working.subagents.count === 1 ? 'child' : 'children'), { count: working.subagents.count }) : null;
  const since = working.turn?.since ?? working.subagents?.since;
  const duration = compact ? compactDuration(since, { now, t }) : workingDuration(since, { now, t });
  const main = working.turn && scheduled ? t(prefix + 'scheduled') : working.turn || !children ? t(prefix + 'processing') : children;
  return { main, duration: compact && !working.turn && children ? null : duration,
    children: !compact && working.turn ? children : null };
}

export function workingText(working, options = {}) {
  const { main, duration, children } = workingParts(working, options);
  return [main, duration, children].filter(Boolean).join(' · ');
}

export function workingNowText(working, { t = key => key, locale } = {}) {
  if (!working?.on) return '';
  const clock = value => formatZoned(new Date(value), locale, { hour: '2-digit', minute: '2-digit' });
  const since = value => Number.isFinite(value) ? t('chat.working.since', { time: clock(value) }) : null;
  const parts = [];
  if (working.turn || !working.subagents) parts.push([
    t('chat.working.processing'), since(working.turn?.since),
  ].filter(Boolean).join(' · '));
  if (working.subagents) parts.push([
    t(working.subagents.count === 1 ? 'chat.working.child' : 'chat.working.children', { count: working.subagents.count }), since(working.subagents.since),
  ].filter(Boolean).join(' · '));
  return t('chat.working.now', { state: parts.join(locale?.startsWith('zh') ? '；' : '; ') });
}
