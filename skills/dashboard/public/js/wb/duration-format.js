/** Chart duration values are seconds; unit labels are supplied by this format. */
export function formatDuration(seconds, maximumFractionDigits = 6, locale) {
  const total = Number(Math.abs(seconds).toFixed(maximumFractionDigits));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60);
  const remainder = Number((total % 60).toFixed(maximumFractionDigits));
  const number = value => new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
  const parts = [];
  if (hours) parts.push(`${number(hours)}h`);
  if (minutes) parts.push(`${number(minutes)}m`);
  if (remainder || !parts.length) parts.push(`${number(remainder)}s`);
  return (seconds < 0 && total ? '-' : '') + parts.join(' ');
}
