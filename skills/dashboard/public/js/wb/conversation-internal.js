import { element, icon } from './plain-text.js?v=105';

/** Internal relays are context between sessions, never user/AI replies or interactive content. */
export function renderInternalMessage({ document, row, t = key => key, onOpenPeer, timeText, timeIso,
  showTechnicalDetails = false }) {
  const article = element(document, 'article', undefined, 'chat-message conversation-message conversation-internal');
  article.dataset.messageId = String(row.id);
  const body = element(document, 'div', undefined, 'conversation-internal-body');
  const heading = element(document, 'div', undefined, 'conversation-internal-heading');
  const label = element(document, 'span', undefined, 'conversation-internal-label');
  const peerSlot = element(document, 'span', undefined, 'conversation-internal-peer-slot');
  const missing = element(document, 'span', undefined, 'conversation-internal-missing');
  const content = element(document, 'div', undefined, 'conversation-internal-content');
  const raw = element(document, 'details', undefined, 'conversation-internal-raw');
  const summary = element(document, 'summary');
  const original = element(document, 'pre');
  raw.append(summary, original);
  heading.append(icon(document, 'msg'), label, peerSlot, missing);
  const time = timeIso ? element(document, 'time', timeText) : null;
  if (time) { time.dateTime = timeIso; heading.append(time); }
  body.append(heading, content, raw);
  article.append(body);
  let current, peer, navigable;
  function update(next, { showTechnicalDetails: technical = false } = {}) {
    current = next;
    const info = next.internal ?? {};
    const canNavigate = info.peerExists === true && typeof info.peerSessionGroup === 'string' && !!info.peerSessionGroup;
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
    label.textContent = t(next.direction === 'out' ? 'chat.internal.sent' : 'chat.internal.received');
    peer.textContent = info.peerDisplayName || info.peerSessionGroup || t('chat.unnamed');
    missing.textContent = t('chat.internal.unavailable');
    missing.hidden = canNavigate;
    content.textContent = typeof info.content === 'string' ? info.content : next.content;
    summary.textContent = t('chat.internal.original');
    original.textContent = next.content;
    raw.hidden = !technical;
  }
  update(row, { showTechnicalDetails });
  return { node: article, time, update };
}
