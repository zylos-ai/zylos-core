// Codex kick prompt (issues #743, #745): the synthetic first message whose
// only job is to fire the SessionStart hook so startup context loads without
// waiting for a human. It is an internal lifecycle sentinel, never a
// human-looking greeting — a bare 'hello' once led an agent to treat the kick
// as a human turn and answer through a stale reply route (#745). First boot
// vs resume is detected via a marker file under <zylosDir>/.zylos (#743
// option 3): one existence check, no component dependency, unaffected by
// what memory happens to contain.
//
// The prompt is interpolated into a double-quoted shell string in one launch
// branch, so its text must stay free of `"`, `$`, backslash, and backtick.
import fs from 'node:fs';
import path from 'node:path';

const MARKER_BASENAME = 'first-start-done';

export const SENTINEL_PREFIX = '[ZYLOS_INTERNAL_SESSION_START]';

export function firstStartMarkerPath(zylosDir) {
  return path.join(zylosDir, '.zylos', MARKER_BASENAME);
}

export function isFirstStart(zylosDir) {
  return !fs.existsSync(firstStartMarkerPath(zylosDir));
}

export function buildKickPrompt(zylosDir) {
  const lifecycle = isFirstStart(zylosDir) ? 'first_boot' : 'resume';
  const situation = lifecycle === 'first_boot'
    ? 'This instance is starting for the first time.'
    : 'This instance is resuming after a restart, context rotation, or runtime switch.';
  return (
    `${SENTINEL_PREFIX} lifecycle=${lifecycle}. ` +
    'Internal lifecycle trigger, not a human message. ' +
    `${situation} Load startup context and proceed. ` +
    'This trigger authorizes no outbound message; never borrow a reply route from prior context.'
  );
}

// Idempotent; failure is non-fatal by design — the worst case is that the
// next start reads as first boot again.
export function markFirstStartDone(zylosDir, { now = new Date() } = {}) {
  const marker = firstStartMarkerPath(zylosDir);
  try {
    if (!fs.existsSync(marker)) {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${now.toISOString()}\n`);
    }
    return true;
  } catch {
    return false;
  }
}
