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
  capacity_wait: {
    zh: '消息已收到。目前同时处理的对话较多，正在排队，空出位置后马上处理。',
    en: 'Your message was received. Several conversations are being handled at the moment, so it is queued and will be processed as soon as a slot becomes available.',
  },
  memory_low: {
    zh: '这台机器内存快用完了，运行可能变慢或不稳定；如果经常出现，请考虑给这台机器增加内存。',
    en: 'This machine is almost out of memory, so things may slow down or become unstable. If this happens often, consider adding memory to this machine.',
  },
};
const REPEATED_FAILURE_TEMPLATES = {
  could_not_restart: {
    zh: '对话「{group}」连续 {count} 次没能重启。最后一次的原因：{reason}。系统会继续重试；已在排队的消息可能在恢复前失败。',
    en: 'Conversation "{group}" could not restart: {count} attempts failed in a row. Last failure: {reason}. It keeps retrying. Messages already queued for this conversation can fail before it recovers.',
  },
  could_not_restart_others: { zh: '另有 {others} 个对话也重启失败。', en: '{others} other conversations are failing too.' },
  could_not_restart_launch_error: { zh: '启动报错（{code}）', en: 'launch error ({code})' },
  could_not_restart_timeout: { zh: '等了 {seconds} 秒还没就绪', en: 'not ready after {seconds} seconds' },
  ended_unexpectedly: {
    zh: '对话「{group}」连续 {count} 次启动后不到 10 分钟就意外结束。系统会继续重起；如果一直这样，请检查这个对话正在做的任务或运行环境。',
    en: 'Conversation "{group}" ended unexpectedly {count} times in a row, each within 10 minutes of starting. It keeps restarting. If this continues, check the task it is working on or its runtime environment.',
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
export function messageForStatus({ health, reason, noticeCode, resetAt, group, count, others, context = 'inbound' } = {}, config = readZylosConfigOrThrow().statusNotices ?? {}) {
  config = config && typeof config === 'object' ? config : {};
  const category = Object.hasOwn(DEFAULTS, noticeCode) ? noticeCode : Object.hasOwn(DEFAULTS, health) ? health : 'unavailable';
  const mode = context === 'repeated_failure' && Object.hasOwn(REPEATED_FAILURE_TEMPLATES, noticeCode) ? 'repeated_failure'
    : context === 'capacity' && Object.hasOwn(CAPACITY_TEMPLATES, noticeCode)
    ? 'capacity' : context === 'failure' ? 'failure' : 'inbound';
  const brand = validText(config.brand, 80) && !/[\r\n]/.test(config.brand) ? config.brand.trim() : 'Zylos';
  const now = Date.now();
  const validReset = Number.isSafeInteger(resetAt) && resetAt > now && resetAt - now <= 8 * 86400000;
  const resetText = validReset ? formatResetTime(resetAt,config.timeZone) : null;
  let code = ['capacity', 'repeated_failure'].includes(mode) ? noticeCode : Object.hasOwn(NOTICE_TEMPLATES,noticeCode) ? noticeCode : null;
  if (code === 'quota_exhausted_reset' && !resetText) code = 'quota_exhausted';
  // Codes and times come from structured, trusted classification. Free-form
  // reason text is never used as content or interpreted as a template ID.
  return ['zh','en'].map(locale => {
    if (mode === 'repeated_failure') {
      const render = (id, values) => {
        const override = config.templates?.repeated_failure?.[id]?.[locale];
        const text = validText(override, 2000) ? override.trim() : REPEATED_FAILURE_TEMPLATES[id][locale];
        return text.replace(/\{(group|count|reason|others|code|seconds)\}/g, (token, key) => values[key] === undefined ? token : String(values[key]));
      };
      const values = { group, count, others };
      if (noticeCode === 'could_not_restart') {
        values.reason = reason?.kind === 'timeout'
          ? render('could_not_restart_timeout', { seconds: reason.seconds })
          : render('could_not_restart_launch_error', { code: reason?.code ?? 'unknown' });
      }
      let body = render(noticeCode, values);
      if (noticeCode === 'could_not_restart' && others >= 1) body += (locale === 'en' ? ' ' : '') + render('could_not_restart_others', values);
      return `[${brand}] ${body}`;
    }
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
