const REASONS = {
  launch_failed: ['会话启动失败', 'session startup failed'],
  ready_timeout: ['会话未及时就绪', 'session readiness timed out'],
  delivery_failed: ['会话无法接收消息', 'the session could not receive the message'],
  pending_expired: ['排队等待超时', 'the queue wait expired'],
  orphan_expired: ['重启恢复时消息已过期', 'the message had expired during restart recovery'],
  orphan_retry_exhausted: ['重启恢复时已用尽投递次数', 'delivery attempts were exhausted during restart recovery'],
};

/** Only stored routing metadata and fixed classifications enter this receipt. */
export function messageForFailureReceipt({ id, session_group: group, reason }) {
  if (!Number.isSafeInteger(id) || id < 1 || typeof group !== 'string' || !group || /[\x00-\x1f\x7f]/.test(group)) {
    throw new TypeError('Invalid failure receipt metadata');
  }
  const [zh, en] = Object.hasOwn(REASONS, reason) ? REASONS[reason] : REASONS.delivery_failed;
  return `[Zylos] 消息 #${id} 没有送达会话组「${group}」：${zh}。请稍后重新发送。\n` +
    `[Zylos] Message #${id} was not delivered to session group "${group}": ${en}. Please resend it later.`;
}
