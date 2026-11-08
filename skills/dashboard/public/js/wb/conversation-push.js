const canonical = value => typeof value === 'string' && /^(?:g:(?:[0-9A-F]{2})+|l:(?:[0-9A-F]{2})+:(?:[0-9A-F]{2})*)$/.test(value);

export function normalizeChatSubscription(value) {
  if (!value || !['mine', 'external'].includes(value.tab)) return null;
  const conversationId = canonical(value.conversationId) ? value.conversationId : null;
  return { tab: value.tab, conversationId };
}
export const chatSubscriptionKey = value => JSON.stringify(normalizeChatSubscription(value));
export function matchesChatEvent(data, subscription) {
  const normalized = normalizeChatSubscription(subscription);
  return !!normalized && data?.version === 1 && data.tab === normalized.tab
    && data.conversationId === normalized.conversationId && Array.isArray(data.ids)
    && data.ids.length <= 100 && data.ids.every(id => Number.isSafeInteger(id) && id > 0)
    && new Set(data.ids).size === data.ids.length;
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
      for (const name of ['chat_ready', 'chat_messages_changed', 'chat_delivery_changed', 'chat_unavailable']) listen(name, event => {
        if (!current()) return;
        try {
          const data = JSON.parse(event.data);
          if (matchesChatEvent(data, captured)) onEvent(name, data, captured);
        } catch { /* A malformed hint is never conversation truth. */ }
      });
      onStatus('connecting', captured);
    },
    detach,
    destroy() { destroyed = true; detach(); subscription = null; }
  };
}
