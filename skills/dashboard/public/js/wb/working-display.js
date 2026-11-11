import { formatZoned } from './instance-zone.js?v=100';

export function workingDuration(since, { now = Date.now(), t = key => key } = {}) {
  if (!Number.isFinite(since)) return null;
  const minutes = Math.floor(Math.max(0, now - since) / 60000);
  if (minutes < 1) return t('chat.working.lessMinute');
  if (minutes < 60) return t('chat.working.minutes', { count: minutes });
  return t('chat.working.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export function workingText(working, { now = Date.now(), t = key => key } = {}) {
  if (!working) return '';
  if (!working.on) return t('wb.state.idle');
  const children = working.subagents?.count > 0 ? t('chat.working.children', { count: working.subagents.count }) : null;
  const duration = workingDuration(working.turn?.since ?? working.subagents?.since, { now, t });
  const main = working.turn || !children ? t('chat.working.processing') : children;
  return [main, duration, working.turn ? children : null].filter(Boolean).join(' · ');
}

export function workingNowText(working, { t = key => key, locale, includeLatest = true } = {}) {
  if (!working?.on) return '';
  const clock = value => formatZoned(new Date(value), locale, { hour: '2-digit', minute: '2-digit' });
  const since = value => Number.isFinite(value) ? t('chat.working.since', { time: clock(value) }) : null;
  const parts = [];
  if (working.turn || !working.subagents) parts.push([
    t('chat.working.processing'), since(working.turn?.since),
  ].filter(Boolean).join(' · '));
  if (working.subagents) parts.push([
    t('chat.working.children', { count: working.subagents.count }), since(working.subagents.since),
  ].filter(Boolean).join(' · '));
  return [t('chat.working.now', { state: parts.join(locale?.startsWith('zh') ? '；' : '; ') }),
    includeLatest && working.subagents && Number.isFinite(working.subagents.lastActivityAt)
      ? t('chat.working.latest', { time: clock(working.subagents.lastActivityAt) }) : null,
  ].filter(Boolean).join(' · ');
}
