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
  memory_low: {
    zh: '这台机器内存快用完了，运行可能变慢或不稳定；如果经常出现，请考虑给这台机器增加内存。',
    en: 'This machine is almost out of memory, so things may slow down or become unstable. If this happens often, consider adding memory to this machine.',
  },
  inputs_unreadable: {
    zh: '系统出现异常，暂时无法确认这台机器的内存是否够用。为了稳定运行，现在只能同时运行一个对话，其他对话会排队等候，回复可能变慢。恢复后会自动回到正常状态，不需要你操作；如果长时间没有恢复，请联系技术支持。',
    en: 'Something is wrong with the system: it cannot confirm whether this machine has enough memory right now. To stay stable, only one conversation can run at a time and others wait in line, so replies may be slower. Things return to normal by themselves once this clears, with nothing for you to do. If it lasts a long time, please contact technical support.',
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
export function messageForStatus({ health, reason, noticeCode, resetAt, context = 'inbound' } = {}, config = readZylosConfigOrThrow().statusNotices ?? {}) {
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
      (!override.includes('{resetAt}') || (code === 'quota_exhausted_reset' && resetText));
    const body = safeOverride ? override.trim() : mode === 'capacity' ? description
      : `${description}${locale === 'en' ? ' ' : ''}${SUFFIXES[mode][locale]}`;
    const rendered = code === 'quota_exhausted_reset' ? body.replaceAll('{resetAt}',resetText) : body;
    return `[${brand}] ${rendered}`;
  }).join('\n');
}
