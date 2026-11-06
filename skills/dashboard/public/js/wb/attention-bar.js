import { element } from './plain-text.js?v=85';
export function renderAttention(root, snapshot, { error, lastSuccess, now = Date.now(), document = root.ownerDocument, t = key => key, level = 'plain' } = {}) {
  root.replaceChildren();
  if (error) root.append(element(document, 'p', t('wb.readFailed') + (lastSuccess == null ? '' : ` · ${t('wb.lastSuccess', { seconds: Math.max(0, Math.floor((now - lastSuccess) / 1000)) })}`)));
  for (const item of [...(snapshot?.attention?.problems ?? []), ...(snapshot?.attention?.reminders ?? [])]) {
    const values = { runtime: item.runtime ?? '', count: item.groups?.length ?? item.count30m ?? '', service: item.service ?? '',
      time: item.until == null ? t('wb.unknown') : new Date(item.until * 1000).toLocaleTimeString() };
    const message = element(document, 'p', t('wb.attention.' + item.kind, values), 'wb-attention-item');
    if (item.kind === 'auth_failed' && item.extraUnknown) message.append(element(document, 'small', t('wb.extraUnknown', { count: item.extraUnknown })));
    const details = [item.reasonCode, item.source, item.pm2Status].filter(Boolean).join(' · ');
    if (level === 'technical' && details) message.append(element(document, 'small', ' · ' + details));
    root.append(message);
  }
}
