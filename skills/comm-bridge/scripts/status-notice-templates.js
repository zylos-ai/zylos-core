import { readZylosConfigOrThrow } from './local-config.js';
import { NOTICE_TEMPLATES } from './status-notice-catalog.js';

const DEFAULTS = {
  rate_limited: {
    zh: '当前服务暂时受限，请稍后重试。',
    en: 'The service is currently rate-limited. Please try again later.',
  },
  auth_failed: {
    zh: '当前认证不可用，恢复访问后才能继续处理，请稍后重试。',
    en: 'Authentication is currently unavailable. Please try again after access is restored.',
  },
  unavailable: {
    zh: '当前服务暂时不可用，请稍后重试。',
    en: 'The service is temporarily unavailable. Please try again later.',
  },
};
const CAPACITY_TEMPLATES = {
  memory_reclaim: {
    zh: '这台机器内存快用完了，已自动关掉一个空闲了 {idleMinutes} 分钟以上的对话；它下次收到消息会自动重新开始。',
    en: 'This machine is almost out of memory, so one conversation that had been idle for more than {idleMinutes} minutes was closed automatically. It will start again by itself when its next message arrives.',
  },
  oom_kill: {
    zh: '这台机器内存不够用，系统刚刚强制结束了一个程序。被打断的对话和服务会自动重新启动；如果经常出现，请考虑给这台机器增加内存。',
    en: 'This machine ran out of memory, and the system just force-stopped a program. Interrupted conversations and services restart automatically. If this happens often, consider adding memory to this machine.',
  },
  inputs_unreadable: {
    zh: '暂时读不到这台机器的内存使用情况。为了安全，现在除系统助手外同时只运行一个对话，其他对话排队等候；恢复读取后会自动调整。',
    en: 'Memory usage on this machine cannot be read right now. To stay safe, only one conversation runs at a time besides the system assistant, and others wait in line. This adjusts automatically once readings recover.',
  },
  publish_failed: {
    zh: '同时运行的对话数量暂时无法更新，系统会按更保守的数量继续运行。',
    en: 'The number of conversations that can run at the same time cannot be updated right now. The system keeps running with a more cautious number.',
  },
};
const SUFFIXES = {
  inbound: {
    zh: '本条消息已收到，但未进入处理队列。',
    en: 'Your message was received but was not added to the processing queue.',
  },
  failure: {
    zh: '本次请求未能完成，请稍后重新发送。',
    en: 'This request could not be completed. Please resend it later.',
  },
};
const FAILURE_REASONS = {
  rate_limited: {
    zh: '服务返回了限流错误。',
    en: 'The service reported a rate limit for this request.',
  },
  auth_failed: {
    zh: '服务返回了认证错误。',
    en: 'The service reported an authentication error for this request.',
  },
  unavailable: {
    zh: '服务返回了请求失败。',
    en: 'The service reported a failure for this request.',
  },
};

function validText(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum &&
    !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
}

function formatResetTime(resetAt, requestedZone) {
  let timeZone = typeof requestedZone === 'string' && requestedZone ? requestedZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  let formatter;
  const options = { year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' };
  try { formatter = new Intl.DateTimeFormat('en-GB',{...options,timeZone}); }
  catch { timeZone = 'UTC'; formatter = new Intl.DateTimeFormat('en-GB',{...options,timeZone}); }
  const parts = Object.fromEntries(formatter.formatToParts(resetAt).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${timeZone}`;
}

// Configuration is trusted operator input. Runtime error text is never rendered.
export function messageForStatus({ health, reason, noticeCode, resetAt, idleMinutes = 5, context = 'inbound' } = {}, config = readZylosConfigOrThrow().statusNotices ?? {}) {
  config = config && typeof config === 'object' ? config : {};
  const category = Object.hasOwn(DEFAULTS, noticeCode) ? noticeCode : Object.hasOwn(DEFAULTS, health) ? health : 'unavailable';
  const mode = context === 'capacity' && Object.hasOwn(CAPACITY_TEMPLATES, noticeCode)
    ? 'capacity' : context === 'failure' ? 'failure' : 'inbound';
  const brand = validText(config.brand, 80) && !/[\r\n]/.test(config.brand) ? config.brand.trim() : 'Zylos';
  const now = Date.now();
  const validReset = Number.isSafeInteger(resetAt) && resetAt > now && resetAt - now <= 8 * 86400000;
  const resetText = validReset ? formatResetTime(resetAt,config.timeZone) : null;
  let code = mode === 'capacity' ? noticeCode : Object.hasOwn(NOTICE_TEMPLATES,noticeCode) ? noticeCode : null;
  if (code === 'quota_exhausted_reset' && !resetText) code = 'quota_exhausted';
  // Codes and times come from structured, trusted classification. Free-form
  // reason text is never used as content or interpreted as a template ID.
  return ['zh','en'].map(locale => {
    const override = config.templates?.[mode]?.[code || category]?.[locale];
    const description = mode === 'capacity' ? CAPACITY_TEMPLATES[code][locale]
      : code ? NOTICE_TEMPLATES[code][locale] : (mode === 'failure' ? FAILURE_REASONS : DEFAULTS)[category][locale];
    const safeOverride = validText(override,2000) &&
      (!override.includes('{resetAt}') || (code === 'quota_exhausted_reset' && resetText)) &&
      (!override.includes('{idleMinutes}') || code === 'memory_reclaim');
    const body = safeOverride ? override.trim() : mode === 'capacity' ? description
      : `${description}${locale === 'en' ? ' ' : ''}${SUFFIXES[mode][locale]}`;
    const rendered = code === 'quota_exhausted_reset' ? body.replaceAll('{resetAt}',resetText)
      : code === 'memory_reclaim' ? body.replaceAll('{idleMinutes}',
        Number.isSafeInteger(idleMinutes) && idleMinutes >= 1 ? String(idleMinutes) : '5') : body;
    return `[${brand}] ${rendered}`;
  }).join('\n');
}
