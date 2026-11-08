import { element, fallbackName, icon } from './plain-text.js?v=104';
import { recoveryTime } from './cooldown.js?v=89';
import { formatZoned } from './instance-zone.js?v=100';
const clock = at => formatZoned(at, undefined, { hour: '2-digit', minute: '2-digit' });
function entry(document, { severity, glyph, text, sub, group, onSelect, t }) {
  const clickable = group !== undefined;
  const node = element(document, clickable ? 'button' : 'div', undefined, `wb-attention-item wb-attention-${severity}`);
  if (clickable) { node.type = 'button'; node.addEventListener('click', () => onSelect(group)); }
  const body = element(document, 'span', undefined, 'wb-attention-text');
  body.append(element(document, 'b', text));
  if (sub) body.append(element(document, 'span', ' · ' + sub, 'wb-sub'));
  node.append(icon(document, glyph), body);
  if (clickable) {
    const go = element(document, 'span', t('wb.attention.view'), 'wb-go');
    go.append(icon(document, 'chev', 'xs'));
    node.append(go);
  }
  return node;
}
/** Attention items name the conclusion first; group items open that group's detail. */
export function renderAttention(root, snapshot, { error, lastSuccess, now = Date.now(), document = root.ownerDocument, t = key => key, level = 'plain', onSelect = () => {} } = {}) {
  root.replaceChildren();
  if (error) root.append(entry(document, { severity: 'problem', glyph: 'alert', text: t('wb.readFailed'), t,
    sub: lastSuccess == null ? '' : t('wb.lastSuccess', { seconds: Math.max(0, Math.floor((now - lastSuccess) / 1000)) }) }));
  const items = [...(snapshot?.attention?.problems ?? []).map(item => [item, 'problem']),
    ...(snapshot?.attention?.reminders ?? []).map(item => [item, 'reminder'])];
  const nameOf = key => {
    const row = snapshot?.rows?.find(value => value.sessionGroup === key) ?? { sessionGroup: key };
    return row.name?.displayName ?? fallbackName(row, t);
  };
  for (const [item, severity] of items) {
    const at = item.kind === 'rate_limited' ? recoveryTime(item.until, now) : null;
    const values = { runtime: item.runtime ? item.runtime.charAt(0).toUpperCase() + item.runtime.slice(1) : '', count: item.groups?.length ?? item.count30m ?? '', service: item.service ?? '',
      time: at === null ? '' : clock(at) };
    const key = 'wb.attention.' + item.kind + (item.kind === 'rate_limited' && at === null ? '_unknown' : '');
    const group = item.group !== undefined ? item.group : item.groups?.length === 1 ? item.groups[0] : undefined;
    const subs = [];
    if (item.group !== undefined) subs.push(nameOf(item.group));
    if (item.kind === 'auth_failed' && item.extraUnknown) subs.push(t('wb.extraUnknown', { count: item.extraUnknown }).replace(/^\s*·\s*/, ''));
    const details = [item.reasonCode, item.source, item.pm2Status].filter(Boolean).join(' · ');
    if (level === 'technical' && details) subs.push(details);
    root.append(entry(document, { severity, glyph: severity === 'reminder' ? 'clock' : 'alert', text: t(key, values),
      sub: subs.join(' · '), group, onSelect, t }));
  }
  if (!error && snapshot && !items.length) {
    const ok = element(document, 'div', undefined, 'wb-attention-ok');
    ok.append(icon(document, 'check'), element(document, 'span', t('wb.attention.allOk')));
    const sampled = snapshot.attention?.sampledAt ?? snapshot.readAt;
    if (level === 'technical' && sampled != null) ok.append(element(document, 'span', ' · ' + t('wb.attention.sampled', { seconds: Math.max(0, Math.floor((now - sampled) / 1000)) }), 'wb-sub'));
    ok.title = t('wb.attention.okHint');
    root.append(ok);
  }
}
