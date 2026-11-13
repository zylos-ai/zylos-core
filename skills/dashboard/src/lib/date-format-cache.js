// Building an Intl.DateTimeFormat is expensive, and the memory it takes is not
// returned promptly after collection. Code that formats many instants reuses one
// formatter per locale and options (the time zone is one of the options). The set
// is bounded by the fixed call sites times valid time zones: an invalid zone
// throws before anything is stored.
const formatters = new Map();

export function cachedDateTimeFormat(locale, options) {
  const key = JSON.stringify([locale, options]);
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, format);
  }
  return format;
}
