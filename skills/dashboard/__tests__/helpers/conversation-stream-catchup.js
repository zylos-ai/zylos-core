// Deliver the same ready event as the application's existing SSE subscription.
// The controller owns message/status reads and every timer; the test fixture
// destroys its page. This helper allocates no transport, clock or resource.
export async function catchUpConversation(page) {
  const subscription = page.streamSubscription();
  page.streamStatus('connecting', subscription);
  page.streamEvent('chat_ready', { version: 1, ...subscription, ids: [] }, subscription);
  for (let i = 0; i < 160; i++) await Promise.resolve();
}
