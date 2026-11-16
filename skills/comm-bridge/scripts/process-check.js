/** Invoke pgrep directly for the current OS user, with the caller's sync or async executor. */
export function runCurrentUserPgrep(pattern, execute, options) {
  return execute('pgrep', ['-u', String(process.getuid()), '-f', pattern], options);
}
