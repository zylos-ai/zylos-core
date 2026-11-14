import { formatZoned } from './instance-zone.js?v=100';

/** Shared caption parts; compact wording belongs only to the phone working pill.
 * `scheduled` is true only while Origin works on what the scheduler last handed it. */
export function workingParts(working, { t = key => key, scheduled = false, compact = false } = {}) {
  if (!working) return { main: '', children: null };
  if (!working.on) return { main: t('wb.state.idle'), children: null };
  const prefix = compact ? 'chat.working.mobile.' : 'chat.working.';
  const children = working.subagents?.count > 0
    ? t(prefix + (working.subagents.count === 1 ? 'child' : 'children'), { count: working.subagents.count }) : null;
  const main = working.main && scheduled ? t(prefix + 'scheduled') : working.main || !children ? t(prefix + 'processing') : children;
  return { main, children: !compact && working.main ? children : null };
}

export function workingText(working, options = {}) {
  const { main, children } = workingParts(working, options);
  return [main, children].filter(Boolean).join(' · ');
}

export function workingNowText(working, { t = key => key, locale } = {}) {
  if (!working?.on) return '';
  const clock = value => formatZoned(new Date(value), locale, { hour: '2-digit', minute: '2-digit' });
  const since = value => Number.isFinite(value) ? t('chat.working.since', { time: clock(value) }) : null;
  const parts = [];
  if (working.main || !working.subagents) parts.push([
    t('chat.working.processing'), since(working.main?.since),
  ].filter(Boolean).join(' · '));
  if (working.subagents) parts.push([
    t(working.subagents.count === 1 ? 'chat.working.child' : 'chat.working.children', { count: working.subagents.count }), since(working.subagents.since),
  ].filter(Boolean).join(' · '));
  return t('chat.working.now', { state: parts.join(locale?.startsWith('zh') ? '；' : '; ') });
}
