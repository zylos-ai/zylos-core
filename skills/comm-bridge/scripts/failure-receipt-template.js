import { readZylosConfigOrThrow } from './local-config.js';

const REASONS = {
  launch_failed: ['会话启动失败', 'session startup failed'],
  ready_timeout: ['会话未及时就绪', 'session readiness timed out'],
  delivery_failed: ['会话无法接收消息', 'the session could not receive the message'],
  delivery_unverified: ['已用尽确认投递次数', 'delivery verification attempts were exhausted'],
  pending_expired: ['排队等待超时', 'the queue wait expired'],
  orphan_expired: ['重启恢复时消息已过期', 'the message had expired during restart recovery'],
  orphan_retry_exhausted: ['重启恢复时已用尽投递次数', 'delivery attempts were exhausted during restart recovery'],
};

function noticeBrand(config) {
  const configuredBrand = config?.brand;
  return typeof configuredBrand === 'string' && configuredBrand.trim() && configuredBrand.length <= 80 &&
    !/[\x00-\x1f\x7f]/.test(configuredBrand) ? configuredBrand.trim() : 'Zylos';
}

/** Only stored routing metadata and fixed classifications enter this receipt. */
export function messageForFailureReceipt({ id, session_group: group, reason }, config = failureAlertConfig()) {
  if (!Number.isSafeInteger(id) || id < 1 || typeof group !== 'string' || !group || /[\x00-\x1f\x7f]/.test(group)) {
    throw new TypeError('Invalid failure receipt metadata');
  }
  const [zh, en] = Object.hasOwn(REASONS, reason) ? REASONS[reason] : REASONS.delivery_failed;
  const brand = noticeBrand(config);
  const uncertain = reason === 'delivery_unverified';
  const prefixZh = uncertain ? '未能确认送达会话组' : '没有送达会话组';
  const prefixEn = uncertain ? 'could not be confirmed delivered to session group' : 'was not delivered to session group';
  return `[${brand}] 消息 #${id} ${prefixZh}「${group}」：${zh}。请稍后重新发送。系统回执，无需回复。\n` +
    `[${brand}] Message #${id} ${prefixEn} "${group}": ${en}. Please resend it later. System receipt; no reply is needed.`;
}

function failureAlertConfig() {
  // Notification rendering must not block terminal settlement on unreadable config.
  try { return readZylosConfigOrThrow().statusNotices ?? {}; }
  catch { return {}; }
}

/** Owner-only metadata summary; never renders the original message body. */
export function messageForFailureAlert(record, config = failureAlertConfig()) {
  const brand = noticeBrand(config);
  const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 512) : '';
  const [zh, en] = Object.hasOwn(REASONS, record.reason) ? REASONS[record.reason] : REASONS.delivery_failed;
  const statusZh = record.reason === 'delivery_unverified' ? '未能确认送达' : '没有送达';
  const statusEn = record.reason === 'delivery_unverified' ? 'could not be confirmed delivered' : 'was not delivered';
  const group = clean(record.session_group), channel = clean(record.channel), endpoint = clean(record.endpoint_id);
  return `[${brand}] 消息 #${record.id}（${channel}:${endpoint || '(无 endpoint)'}）${statusZh}会话「${group}」：${zh}。\n` +
    `需要我排查原因吗？需要的话请直接回复这条消息。\n\n` +
    `[${brand}] Message #${record.id} (${channel}:${endpoint || '(no endpoint)'}) ${statusEn} to session "${group}": ${en}.\n` +
    `Would you like me to investigate? If so, please reply directly to this message.`;
}
