import { projectConversation } from '../../comm-bridge/scripts/c4-query-format.js';

export const DREAM_BATCH_BYTES = 150 * 1024;
const OMIT_BLOCKS = ['openmax-instruction', 'smart-mode'];
const OMIT_TAGS = /<(?:org-context|message-context|sender-context)\b[^>]*\/\s*>|<current-message(?: c4_id="[1-9][0-9]*")?>|<\/current-message>/g;

export function cleanDreamMessage(text) {
  for (const tag of OMIT_BLOCKS) text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\/${tag}>`, 'g'), '');
  return text.replace(OMIT_TAGS, '').replace(/(<replying-to>)([\s\S]*?)(<\/replying-to>)/g,
    (_, open, body, close) => open + [...body].slice(0, 200).join('') + close).trim();
}

function formatTimestamp(timestamp, formatter) {
  const date = new Date(typeof timestamp === 'number' ? timestamp * 1000 :
    timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(date.valueOf())) return timestamp;
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function makeDreamBatches(conversations, date, timezone, limit = DREAM_BATCH_BYTES) {
  const prefix = `Day: ${date} (${timezone}). Raw messages follow.\n`;
  const size = Buffer.byteLength;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const batches = [];
  const noticeOnly = [];
  let shortGroups = [], shortSize = size(prefix);
  const flushShort = () => {
    if (shortGroups.length) batches.push(shortGroups);
    shortGroups = [];
    shortSize = size(prefix);
  };

  for (const { group, rows } of conversations) {
    if (!rows.length) continue;
    const heading = `\n## Group ${group}\n`;
    const capacity = limit - size(prefix + heading);
    if (capacity < 4) throw new RangeError('Dream batch limit is too small for its header');
    const messages = [];
    for (const row of rows) {
      if (row.direction === 'out' && row.delivery_action === 'system_notice') {
        // Carry the notice's ID through the last complete message in this batch.
        if (messages.length) messages.at(-1).end = row.id;
        continue;
      }
      const { content } = projectConversation(row);
      messages.push({ end: row.id, text: `\n[${formatTimestamp(row.timestamp, formatter)} ${row.direction.toUpperCase()}]\n` +
        `(C4 #${row.id})\n${cleanDreamMessage(content)}\n` });
    }
    if (!messages.length) {
      noticeOnly.push({ group, end: rows.at(-1).id });
      continue;
    }
    const total = messages.reduce((sum, { text }) => sum + size(text), 0);
    if (total <= capacity) {
      const bytes = size(heading) + total;
      if (shortSize + bytes > limit) flushShort();
      shortGroups.push({ group, heading, text: messages.map(message => message.text).join(''), end: messages.at(-1).end });
      shortSize += bytes;
      continue;
    }
    let text = '', end = null, bytes = 0;
    const flushGroup = () => {
      if (text) batches.push([{ group, heading, text, end }]);
      text = ''; end = null; bytes = 0;
    };
    for (const message of messages) {
      const data = Buffer.from(message.text);
      if (bytes + data.length > capacity) flushGroup();
      let offset = 0;
      while (data.length - offset > capacity) {
        // Split very large individual messages on a UTF-8 boundary. Only the
        // batch with the final fragment can cover the message's ID.
        let boundary = offset + capacity;
        while ((data[boundary] & 0xc0) === 0x80) boundary--;
        text = data.toString('utf8', offset, boundary);
        flushGroup();
        offset = boundary;
      }
      text += data.toString('utf8', offset);
      bytes += data.length - offset;
      end = message.end;
    }
    flushGroup();
  }
  flushShort();
  const modelBatches = batches.map(groups => ({
    groups: groups.map(({ group, end }) => ({ group, end })),
    input: prefix + groups.map(({ heading, text }) => heading + text).join(''),
  }));
  return { batches: modelBatches, noticeOnly };
}
