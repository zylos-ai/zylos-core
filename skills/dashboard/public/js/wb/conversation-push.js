const canonical = value => typeof value === 'string' && /^(?:g:(?:[0-9A-F]{2})+|l:(?:[0-9A-F]{2})+:(?:[0-9A-F]{2})*)$/.test(value);

export function normalizeChatSubscription(value) {
  if (!value || !['mine', 'external'].includes(value.tab)) return null;
  const conversationId = canonical(value.conversationId) ? value.conversationId : null;
  const ids = conversationId && value.tab === 'mine' && Array.isArray(value.ids)
    ? [...new Set(value.ids.filter(id => Number.isSafeInteger(id) && id > 0))].slice(-100).sort((a, b) => a - b) : [];
  return { tab: value.tab, conversationId, ids };
}
export const chatSubscriptionKey = value => JSON.stringify(normalizeChatSubscription(value));
export function matchesChatEvent(data, subscription) {
  const normalized = normalizeChatSubscription(subscription);
  return !!normalized && data?.version === 1 && data.tab === normalized.tab
    && data.conversationId === normalized.conversationId && Array.isArray(data.ids)
    && data.ids.length === normalized.ids.length && data.ids.every((id, index) => id === normalized.ids[index]);
}

/** Chat attaches to the application's existing stream; this never creates one. */
export function createConversationPush({ onSubscriptionChange = () => {}, onStatus = () => {}, onEvent = () => {}, isCurrent = () => true } = {}) {
  let subscription = null, source = null, removers = [], destroyed = false;
  function detach() {
    for (const remove of removers) remove();
    removers = [];
    source = null;
  }
  return {
    setSubscription(value) {
      if (destroyed) return;
      const next = normalizeChatSubscription(value);
      if (chatSubscriptionKey(next) === chatSubscriptionKey(subscription)) return;
      subscription = next;
      detach();
      onSubscriptionChange(next);
    },
    streamUrl(path) {
      if (!subscription) return path;
      const params = new URLSearchParams({ chat: '1', chat_tab: subscription.tab });
      if (subscription.conversationId) params.set('chat_conversation', subscription.conversationId);
      if (subscription.ids.length) params.set('chat_ids', subscription.ids.join(','));
      return path + (path.includes('?') ? '&' : '?') + params;
    },
    attach(next) {
      detach();
      if (destroyed || !subscription) return;
      source = next;
      const captured = subscription, key = chatSubscriptionKey(captured);
      const current = () => source === next && !destroyed && isCurrent(next) && key === chatSubscriptionKey(subscription);
      const listen = (name, fn) => {
        next.addEventListener(name, fn);
        removers.push(() => next.removeEventListener(name, fn));
      };
      for (const name of ['chat_ready', 'chat_messages_changed', 'chat_delivery_changed']) listen(name, event => {
        if (!current()) return;
        try {
          const data = JSON.parse(event.data);
          if (matchesChatEvent(data, captured)) onEvent(name, data, captured);
        } catch { /* A malformed hint is never conversation truth. */ }
      });
      listen('error', () => { if (current()) onStatus('disconnected', captured); });
      onStatus('connecting', captured);
    },
    detach,
    destroy() { destroyed = true; detach(); subscription = null; }
  };
}
