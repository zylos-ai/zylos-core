// Building an Intl.DateTimeFormat is expensive, and the memory it takes is not
// returned promptly after collection. Code that formats many instants reuses one
// formatter per locale and options (the time zone is one of the options).
// Request parameters can name thousands of valid zones and offsets, so the cache
// holds at most MAX_CACHED_FORMATTERS entries: when full, it is emptied before
// the next formatter is stored.
export const MAX_CACHED_FORMATTERS = 64;
const formatters = new Map();

export function cachedDateTimeFormat(locale, options) {
  const key = JSON.stringify([locale, options]);
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    if (formatters.size >= MAX_CACHED_FORMATTERS) formatters.clear();
    formatters.set(key, format);
  }
  return format;
}

/** Number of formatters currently held (read-only view for diagnostics and tests). */
export function cachedFormatterCount() {
  return formatters.size;
}
