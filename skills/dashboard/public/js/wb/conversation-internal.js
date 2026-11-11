import { element } from './plain-text.js?v=106';

/** Internal relays are context between sessions, never user/AI replies or interactive content. */
export function renderInternalMessage({ document, row, t = key => key, onOpenPeer, timeText, timeIso,
  showTechnicalDetails = false, external = false }) {
  const article = element(document, 'article', undefined, 'chat-message conversation-message conversation-internal');
  article.dataset.messageId = String(row.id);
  const spacer = element(document, 'span', undefined, 'conversation-avatar conversation-internal-spacer');
  spacer.setAttribute('aria-hidden', 'true');
  const body = element(document, 'div', undefined, 'conversation-message-body conversation-internal-body');
  const heading = element(document, 'div', undefined, 'conversation-message-meta conversation-internal-heading');
  const route = element(document, 'span', undefined, 'conversation-internal-route');
  const label = element(document, 'span', undefined, 'conversation-internal-label');
  const peerSlot = element(document, 'span', undefined, 'conversation-internal-peer-slot');
  const missing = element(document, 'span', undefined, 'conversation-internal-missing');
  const bubble = element(document, 'div', undefined, 'chat-message-content');
  const content = element(document, 'div', undefined, 'chat-message-text conversation-internal-content');
  bubble.append(content);
  const raw = element(document, 'details', undefined, 'conversation-internal-raw');
  const summary = element(document, 'summary');
  const original = element(document, 'pre');
  raw.append(summary, original);
  route.append(label, peerSlot, missing);
  heading.append(route);
  const time = timeIso ? element(document, 'time', timeText) : null;
  if (time) { time.dateTime = timeIso; heading.append(time); }
  body.append(heading, bubble, raw);
  article.append(spacer, body);
  let current, peer, navigable, badge = null;
  function update(next, { showTechnicalDetails: technical = false, external: externalTab = external } = {}) {
    current = next;
    article.classList.toggle('chat-in', next.direction !== 'out');
    article.classList.toggle('chat-out', next.direction === 'out');
    const info = next.internal ?? {};
    const isOrigin = info.peerSessionGroup === 'origin';
    const canNavigate = !isOrigin && info.peerExists === true && typeof info.peerSessionGroup === 'string' && !!info.peerSessionGroup;
    if (!peer || canNavigate !== navigable) {
      navigable = canNavigate;
      peer = element(document, canNavigate ? 'button' : 'span', undefined, 'conversation-internal-peer');
      if (canNavigate) {
        peer.type = 'button';
        peer.addEventListener('click', () => {
          const latest = current.internal;
          if (latest?.peerExists === true) void onOpenPeer?.(latest.peerSessionGroup, latest.peerChannel);
        });
      }
      peerSlot.replaceChildren(peer);
    }
    label.textContent = t(externalTab
      ? next.direction === 'out' ? 'chat.external.internalSent' : 'chat.external.internalReceived'
      : next.direction === 'out' ? 'chat.internal.sent' : 'chat.internal.received');
    if (externalTab) {
      if (!badge) { badge = element(document, 'span', undefined, 'conversation-internal-badge'); route.append(badge); }
      badge.textContent = t('chat.external.internal');
    } else if (badge) { badge.remove(); badge = null; }
    peer.textContent = isOrigin ? t('wb.term.origin') : info.peerDisplayName || info.peerSessionGroup || t('chat.unnamed');
    missing.textContent = t('chat.internal.unavailable');
    missing.hidden = isOrigin || canNavigate;
    content.textContent = typeof info.content === 'string' ? info.content : next.content;
    summary.textContent = t('chat.internal.original');
    original.textContent = next.content;
    raw.hidden = next.direction === 'out' || (!externalTab && !technical);
  }
  update(row, { showTechnicalDetails });
  return { node: article, time, update };
}
