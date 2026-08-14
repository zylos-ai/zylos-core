// Codex kick prompt (issues #743, #745): the synthetic first message whose
// only job is to fire the SessionStart hook so startup context loads without
// waiting for a human. It is an internal lifecycle sentinel, never a
// human-looking greeting — a bare 'hello' once led an agent to treat the kick
// as a human turn and answer through a stale reply route (#745), and read
// oddly when a session resumed after rotation (#743).
//
// The sentinel is deliberately stateless and deliberately short: one
// constant that covers both a fresh start and a resume. Distinguishing the
// two would require persisted state plus proof that a launch actually
// succeeded before committing it (see the #757 review history) — complexity
// nothing consumes, since the authoritative first-boot signal is the
// onboarding state in memory, not the kick text. And it stays one sentence
// because the kick only fires the hook — the real guidance belongs to the
// hook-injected startup context, and a preachy prompt would itself skew the
// agent's behavior.
//
// The prompt is interpolated into a double-quoted shell string in one launch
// branch, so its text must stay free of `"`, `$`, backslash, and backtick.

const KICK_PROMPT =
  'System startup trigger, not a user message. Continue with startup context.';

export function buildKickPrompt() {
  return KICK_PROMPT;
}
