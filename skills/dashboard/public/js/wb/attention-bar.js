import { element } from './plain-text.js?v=85';
import { recoveryTime } from './cooldown.js?v=89';
export function renderAttention(root, snapshot, { error, lastSuccess, now = Date.now(), document = root.ownerDocument, t = key => key, level = 'plain' } = {}) {
  root.replaceChildren();
  if (error) root.append(element(document, 'p', t('wb.readFailed') + (lastSuccess == null ? '' : ` · ${t('wb.lastSuccess', { seconds: Math.max(0, Math.floor((now - lastSuccess) / 1000)) })}`)));
  const items = [...(snapshot?.attention?.problems ?? []).map(item => [item, 'problem']),
    ...(snapshot?.attention?.reminders ?? []).map(item => [item, 'reminder'])];
  for (const [item, severity] of items) {
    const at = item.kind === 'rate_limited' ? recoveryTime(item.until, now) : null;
    const values = { runtime: item.runtime ?? '', count: item.groups?.length ?? item.count30m ?? '', service: item.service ?? '',
      time: at === null ? '' : new Date(at).toLocaleTimeString() };
    const key = 'wb.attention.' + item.kind + (item.kind === 'rate_limited' && at === null ? '_unknown' : '');
    const message = element(document, 'p', t(key, values), `wb-attention-item wb-attention-${severity}`);
    if (item.kind === 'auth_failed' && item.extraUnknown) message.append(element(document, 'small', t('wb.extraUnknown', { count: item.extraUnknown })));
    const details = [item.reasonCode, item.source, item.pm2Status].filter(Boolean).join(' · ');
    if (level === 'technical' && details) message.append(element(document, 'small', ' · ' + details));
    root.append(message);
  }
}
