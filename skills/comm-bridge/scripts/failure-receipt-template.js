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

/** Only stored routing metadata and fixed classifications enter this receipt. */
export function messageForFailureReceipt({ id, session_group: group, reason, channel }, config = readZylosConfigOrThrow().statusNotices ?? {}) {
  if (!Number.isSafeInteger(id) || id < 1 || typeof group !== 'string' || !group || /[\x00-\x1f\x7f]/.test(group)) {
    throw new TypeError('Invalid failure receipt metadata');
  }
  const [zh, en] = Object.hasOwn(REASONS, reason) ? REASONS[reason] : REASONS.delivery_failed;
  const configuredBrand = config?.brand;
  const brand = typeof configuredBrand === 'string' && configuredBrand.trim() && configuredBrand.length <= 80 &&
    !/[\x00-\x1f\x7f]/.test(configuredBrand) ? configuredBrand.trim() : 'Zylos';
  const uncertain = reason === 'delivery_unverified';
  const prefixZh = uncertain ? '未能确认送达会话组' : '没有送达会话组';
  const prefixEn = uncertain ? 'could not be confirmed delivered to session group' : 'was not delivered to session group';
  const suffixZh = channel === 'internal' ? '系统回执，无需回复。' : '';
  const suffixEn = channel === 'internal' ? ' System receipt; no reply is needed.' : '';
  return `[${brand}] 消息 #${id} ${prefixZh}「${group}」：${zh}。请稍后重新发送。${suffixZh}\n` +
    `[${brand}] Message #${id} ${prefixEn} "${group}": ${en}. Please resend it later.${suffixEn}`;
}

/** Owner-only metadata summary; never renders the scheduler message body. */
export function messageForScheduledFailureAlert(record) {
  const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 512) : '';
  const name = clean(record.task_name) || '未命名定时任务 / unnamed scheduled task';
  const [zh, en] = Object.hasOwn(REASONS, record.reason) ? REASONS[record.reason] : REASONS.delivery_failed;
  return `定时任务「${name}」消息未送达：${zh}。\n` +
    `目标会话组：${clean(record.session_group)}\n目标聊天：${clean(record.channel)}:${clean(record.endpoint_id) || '(无 endpoint)'}\n` +
    `可以到该聊天里让对应会话排查原因。\n` +
    `Scheduled task "${name}" was not delivered: ${en}. Ask the corresponding session in that chat to investigate.`;
}
