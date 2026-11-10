import { fileURLToPath } from 'node:url';
import { dataError } from './c4-session-group.js';
import { shellQuote } from './c4-query-format.js';

export function assertOutboundSession(senderGroup, ownerGroup, request) {
  if (senderGroup === ownerGroup) return;
  const script = fileURLToPath(new URL('./c4-send.js', import.meta.url));
  const command = `  cat <<'EOF_INTERNAL' | node ${shellQuote(script)} internal ${shellQuote(ownerGroup)}`;
  const ownership = `belongs to session group "${ownerGroup}", not to this thread ("${senderGroup}"). Nothing was sent or recorded.`;
  const message = request.runId !== undefined
    ? `absorbed message ${request.id} ${ownership}\nAsk that thread to reply: send an internal message with the reply text and this command for it to run.\n${command}\n  Please reply to absorbed message ${request.id} with: <text>. Why: <reason>.\n  Command: c4-send.js --absorbed-reply ${request.runId} ${request.id}\n  EOF_INTERNAL`
    : `this ${request.channel} address ${ownership}\nEach address is handled by one thread. Ask that thread to deliver it: send an internal message saying what to deliver, to whom (channel and the address you used), and why.\n${command}\n  Please deliver to ${request.channel} <address>: <text>. Why: <reason>.\n  EOF_INTERNAL\nIf "${ownerGroup}" has no thread yet, this message creates it.`;
  throw dataError('CROSS_SESSION_OUTBOUND', message);
}
