/**
 * Terminal color utilities for zylos CLI.
 *
 * Zero dependencies — uses native ANSI escape codes.
 * Auto-disables color when piped or NO_COLOR is set.
 */

const enabled =
  process.env.FORCE_COLOR === '1' ||
  (!process.env.NO_COLOR && process.stdout.isTTY);

function wrap(code, resetCode = '0') {
  if (!enabled) return (s) => s;
  return (s) => `\x1b[${code}m${s}\x1b[${resetCode}m`;
}

export const bold = wrap('1', '22');
export const dim = wrap('2', '22');
export const green = wrap('32', '39');
export const red = wrap('31', '39');
export const yellow = wrap('33', '39');
export const cyan = wrap('36', '39');

// Composed styles
export const success = (s) => green(`✓ ${s}`);
export const error = (s) => red(`✗ ${s}`);
export const warn = (s) => yellow(`⚠ ${s}`);
export const heading = (s) => bold(cyan(s));
