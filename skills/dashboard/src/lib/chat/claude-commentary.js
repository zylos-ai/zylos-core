import { claudeTurnBoundaries } from '../../../public/js/wb/timeline-rows.js';

export function claudeCommentary(outer = 'event') {
  return `CASE WHEN ${outer}.runtime = 'claude' AND ${outer}.event_type = 'assistant_message' THEN
    COALESCE((SELECT later.event_type = 'pre_tool_use' FROM runtime_events later
      WHERE later.session_group IS ${outer}.session_group AND later.session_id IS ${outer}.session_id
      AND later.run_id IS ${outer}.run_id AND later.runtime = 'claude' AND later.timestamp >= ${outer}.timestamp
      AND (later.timestamp > ${outer}.timestamp OR later.event_seq > ${outer}.event_seq)
      AND later.event_type IN ('pre_tool_use',${claudeTurnBoundaries.map(type => `'${type}'`).join(',')})
      AND (CASE WHEN json_valid(later.metadata) THEN json_extract(later.metadata, '$.agent_id') END) IS
        (CASE WHEN json_valid(${outer}.metadata) THEN json_extract(${outer}.metadata, '$.agent_id') END)
      AND (later.event_type <> 'pre_tool_use' OR CASE WHEN json_valid(later.metadata) THEN
        NULLIF(json_extract(later.metadata, '$.tool_use_id'), '') IS NOT NULL
        AND COALESCE(json_extract(later.metadata, '$.tool_name'), '') NOT IN ('Agent','Task') END)
      ORDER BY later.timestamp, later.event_seq LIMIT 1), 0) END`;
}
