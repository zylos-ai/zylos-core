// Plain-language cron rules shared by the browser and the server. Only common
// shapes are described; every other expression is returned unchanged.
const words = {
  zh: {
    daily: time => `每天 ${time}`,
    weekdays: time => `工作日 ${time}`,
    weekly: (days, time) => `每周${days.join('、')} ${time}`,
    monthly: (day, time) => `每月 ${day} 日 ${time}`,
    quarterly: (day, time) => `每季度首月 ${day} 日 ${time}`,
    minutes: k => `每 ${k} 分钟`,
    hours: k => `每 ${k} 小时`,
    days: ['日', '一', '二', '三', '四', '五', '六'],
    timeJoin: '、',
  },
  en: {
    daily: time => `Every day at ${time}`,
    weekdays: time => `Weekdays at ${time}`,
    weekly: (days, time) => `Every ${days.join(', ')} at ${time}`,
    monthly: (day, time) => `Day ${day} of every month at ${time}`,
    quarterly: (day, time) => `Day ${day} of the first month of each quarter at ${time}`,
    minutes: k => `Every ${k} minutes`,
    hours: k => `Every ${k} hours`,
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    timeJoin: ', ',
  },
};

const integer = (value, min, max) => {
  if (!/^\d{1,2}$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
};
const step = value => {
  const match = /^\*\/(\d{1,2})$/.exec(value);
  const k = match ? Number(match[1]) : 0;
  return k > 0 ? k : null;
};
const pad = value => String(value).padStart(2, '0');

export function cronText(expr, locale = 'zh') {
  const text = String(expr ?? '');
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) return text;
  const lang = words[locale === 'en' ? 'en' : 'zh'];
  const [minute, hour, day, month, weekday] = fields;
  const minutes = step(minute);
  if (minutes && [hour, day, month, weekday].every(field => field === '*')) return lang.minutes(minutes);
  const hours = step(hour);
  if (minute === '0' && hours && [day, month, weekday].every(field => field === '*')) return lang.hours(hours);
  const m = integer(minute, 0, 59);
  // A short hour list ("0,12") reads as several times a day: 每天 00:00、12:00.
  const hours24 = hour.split(',').map(value => integer(value, 0, 23));
  if (m === null || hours24.includes(null) || hours24.length > 6) return text;
  const time = [...new Set(hours24)].sort((a, b) => a - b).map(h => `${pad(h)}:${pad(m)}`).join(lang.timeJoin);
  if (day === '*' && month === '*' && weekday === '*') return lang.daily(time);
  if (day === '*' && month === '*') {
    if (weekday === '1-5') return lang.weekdays(time);
    const list = weekday.split(',').map(value => integer(value, 0, 7));
    if (list.includes(null)) return text;
    const unique = [...new Set(list.map(value => value % 7))].sort((a, b) => (a || 7) - (b || 7));
    return lang.weekly(unique.map(value => lang.days[value]), time);
  }
  const date = integer(day, 1, 31);
  if (date === null || weekday !== '*') return text;
  if (month === '*') return lang.monthly(date, time);
  if (month === '1,4,7,10') return lang.quarterly(date, time);
  return text;
}
