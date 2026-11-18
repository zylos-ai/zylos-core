import { fileURLToPath } from 'node:url';
import { dataError } from './c4-session-group.js';
import { shellQuote } from './c4-query-format.js';
import { loadCoreConfig } from './core-config-loader.js';

export async function readConfiguredSessionMode() {
  const { readSessionMode } = await loadCoreConfig();
  return readSessionMode();
}

/**
 * Only Origin and senders without a session environment read session_mode from config.json. A missing
 * file or key keeps the pre-migration rules; an unreadable file keeps the
 * multi rules and leaves one warning line instead of refusing the send.
 */
export async function isNativeSingle(readMode = readConfiguredSessionMode, warn = line => console.error(line)) {
  try {
    const { mode, keyPresent } = await readMode();
    return keyPresent === true && mode === 'single';
  } catch (error) {
    const reason = String(error?.message ?? error).replace(/\s+/g, ' ').trim();
    warn(`[C4] WARNING: cannot read session_mode from config.json (${reason}); sending under multi-session rules.`);
    return false;
  }
}

/**
 * After a switch back to multi, the Origin run that crossed the switch may
 * still answer the exact addresses that were delivered to it in single mode.
 * The exception ends with that run: any later Origin run ending closes it.
 */
export function originReplyAllowed(api, channel, endpoint) {
  const transition = api.getLastCompletedModeTransition();
  if (transition?.target_mode !== 'multi') return false;
  const [ending] = api.listRunEndings(['origin']);
  if (ending && !(ending.endedAt < transition.updated_at)) return false;
  return Boolean(api.getDb().prepare("SELECT 1 FROM conversations WHERE channel=? AND endpoint_id=? AND direction='in' AND session_group='origin' LIMIT 1")
    .get(channel, endpoint));
}

export function assertOutboundSession(senderGroup, ownerGroup, request) {
  if (senderGroup === ownerGroup) return;
  const script = fileURLToPath(new URL('./c4-send.js', import.meta.url));
  const command = `cat <<'EOF_INTERNAL' | node ${shellQuote(script)} internal ${shellQuote(ownerGroup)}`;
  const ownership = `belongs to session group "${ownerGroup}", not to this thread ("${senderGroup}"). Nothing was sent or recorded.`;
  const message = request.runId !== undefined
    ? `absorbed message ${request.id} ${ownership}\nAsk that thread to reply: send an internal message with the reply text and this command for it to run.\n${command}\nPlease reply to absorbed message ${request.id} with: <text>. Why: <reason>.\nCommand: c4-send.js --absorbed-reply ${request.runId} ${request.id}\nEOF_INTERNAL`
    : `this ${request.channel} address ${ownership}\nEach address is handled by one thread. Ask that thread to deliver it: send an internal message saying what to deliver, to whom (channel and the address you used), and why.\n${command}\nPlease deliver to ${request.channel} <address>: <text>. Why: <reason>.\nEOF_INTERNAL\nIf "${ownerGroup}" has no thread yet, this message creates it.`;
  throw dataError('CROSS_SESSION_OUTBOUND', message);
}
