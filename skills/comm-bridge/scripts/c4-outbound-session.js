import { fileURLToPath } from 'node:url';
import { dataError } from './c4-session-group.js';
import { shellQuote } from './c4-query-format.js';

export function assertOutboundSession(senderGroup, ownerGroup) {
  if (!senderGroup || !ownerGroup || senderGroup === ownerGroup) return;
  const script = fileURLToPath(new URL('./c4-send.js', import.meta.url));
  // Internal sends require an explicit group, including an inferred Origin.
  const origin = senderGroup === 'origin' ? "ZYLOS_SESSION_GROUP='origin' " : '';
  const command = `cat <<'EOF_INTERNAL' | ${origin}node ${shellQuote(script)} internal ${shellQuote(ownerGroup)}\nPlease relay the message to the external recipient. Include the destination, message and context here.\nEOF_INTERNAL`;
  throw dataError('CROSS_SESSION_OUTBOUND',
    `This recipient is handled by session ${ownerGroup}; sender session ${senderGroup} cannot send directly. Nothing was sent or recorded. Ask the responsible session to relay it using this internal message command:\n${command}`);
}
