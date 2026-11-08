import { element } from './plain-text.js?v=104';
import { formatZoned } from './instance-zone.js?v=100';
const CLOCK_SECONDS = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
export function activityStrip(document, data, { inboundUnknown = false, t = key => key } = {}) {
  const root = element(document, 'div', undefined, 'wb-activity');
  const width = (data?.cellSeconds ?? 60) * 1000;
  for (const [index, state] of (data?.cells ?? []).entries()) {
    const start = (data.start ?? 0) + index * width;
    const bar = element(document, 'span', undefined, `wb-bucket wb-${state}`);
    bar.title = `${formatZoned(start, undefined, CLOCK_SECONDS)} – ${formatZoned(start + width, undefined, CLOCK_SECONDS)} · ${t('wb.state.' + state)}`;
    if (!inboundUnknown && data.inbound?.some(at => at >= start && at < start + width)) bar.classList.add('wb-inbound');
    root.append(bar);
  }
  if (inboundUnknown) { root.title = t('wb.inboundUnknown'); root.dataset.inbound = 'unknown'; }
  return root;
}
