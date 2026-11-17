/**
 * Environment for a claude/codex process that zylos starts as a helper (an
 * upgrade evaluation, doctor's fixer, an auth or setup-token probe). The run
 * variables are dropped so the helper does not claim the session it was
 * started from. This is hygiene only: the hook entry refuses child runtimes
 * whether or not these variables are set.
 */
export function childRuntimeEnv(env = process.env) {
  const child = { ...env };
  delete child.ZYLOS_SESSION_GROUP;
  delete child.ZYLOS_RUN_ID;
  return child;
}
