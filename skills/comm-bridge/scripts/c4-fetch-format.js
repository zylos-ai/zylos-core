import { resolveDashboardQuotes, dashboardQuoteSender, readOwnerName } from './dashboard-source.js';
import { quotePreview } from '../../dashboard/src/lib/chat/history.js';
import { replyVia } from './c4-query-format.js';

export function formatConversations(rows, { getDatabase, sendPath }) {
  const quoted = resolveDashboardQuotes(rows, getDatabase);
  const owner = quoted.size ? readOwnerName() : null;
  return rows.map(row => {
    const route = row.direction === 'in' && row.endpoint_id !== null ? '\n' + replyVia(row, sendPath) : '';
    const target = quoted.get(row.id);
    let content = row.content;
    if (target) {
      const preview = `(quoting c4_id=${target.id} — ${dashboardQuoteSender(target, owner)}: ${quotePreview(target, { singleLine: true })})`;
      const end = content.indexOf('\n');
      content = end < 0 ? content + '\n' + preview
        : content.slice(0, end + 1) + preview + '\n' + content.slice(end + 1);
    }
    return `[${row.timestamp}] ${row.direction === 'in' ? 'IN' : 'OUT'} (${row.channel}${row.endpoint_id ? ':' + row.endpoint_id : ''}):\n${content}${route}\n`;
  }).join('\n');
}

export function formatUnsummarized(result, options) {
  return `unsummarized scope=${options.scope} checkpointEnd=${result.checkpointEnd}\n${result.checkpointSummary === null ? '' : '[Last Checkpoint Summary] ' + result.checkpointSummary + '\n'}${formatConversations(result.rows, options)}\ncount=${result.rows.length} upTo=${result.upTo} safeEnd=${result.safeEnd}\n`;
}
