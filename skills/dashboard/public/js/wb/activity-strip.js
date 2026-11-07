import { element } from './plain-text.js?v=94';
export function activityStrip(document, data, { inboundUnknown = false, t = key => key } = {}) {
  const root = element(document, 'div', undefined, 'wb-activity');
  const width = (data?.cellSeconds ?? 60) * 1000;
  for (const [index, state] of (data?.cells ?? []).entries()) {
    const start = (data.start ?? 0) + index * width;
    const bar = element(document, 'span', undefined, `wb-bucket wb-${state}`);
    bar.title = `${new Date(start).toLocaleTimeString()} – ${new Date(start + width).toLocaleTimeString()} · ${t('wb.state.' + state)}`;
    if (!inboundUnknown && data.inbound?.some(at => at >= start && at < start + width)) bar.classList.add('wb-inbound');
    root.append(bar);
  }
  if (inboundUnknown) { root.title = t('wb.inboundUnknown'); root.dataset.inbound = 'unknown'; }
  return root;
}
