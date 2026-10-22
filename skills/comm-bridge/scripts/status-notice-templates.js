import { STATUS_NOTICE_CONFIG } from './c4-config.js';
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
export function messageForStatus({ health, reason, noticeCode, resetAt, context = 'inbound' } = {}, config = STATUS_NOTICE_CONFIG) {
  config = config && typeof config === 'object' ? config : {};
  const category = Object.hasOwn(DEFAULTS, noticeCode) ? noticeCode : Object.hasOwn(DEFAULTS, health) ? health : 'unavailable';
  const mode = context === 'failure' ? 'failure' : 'inbound';
  const brand = validText(config.brand, 80) && !/[\r\n]/.test(config.brand) ? config.brand.trim() : 'Zylos';
  const now = Date.now();
  const validReset = Number.isSafeInteger(resetAt) && resetAt > now && resetAt - now <= 8 * 86400000;
  const resetText = validReset ? formatResetTime(resetAt,config.timeZone) : null;
  let code = Object.hasOwn(NOTICE_TEMPLATES,noticeCode) ? noticeCode : null;
  if (code === 'quota_exhausted_reset' && !resetText) code = 'quota_exhausted';
  // Codes and times come from structured, trusted classification. Free-form
  // reason text is never used as content or interpreted as a template ID.
  return ['zh','en'].map(locale => {
    const override = config.templates?.[mode]?.[code || category]?.[locale];
    const description = code ? NOTICE_TEMPLATES[code][locale] : (mode === 'failure' ? FAILURE_REASONS : DEFAULTS)[category][locale];
    const safeOverride = validText(override,2000) && (!override.includes('{resetAt}') || (code === 'quota_exhausted_reset' && resetText));
    const body = safeOverride ? override.trim() : `${description}${locale === 'en' ? ' ' : ''}${SUFFIXES[mode][locale]}`;
    const rendered = code === 'quota_exhausted_reset' ? body.replaceAll('{resetAt}',resetText) : body;
    return `[${brand}] ${rendered}`;
  }).join('\n');
}
