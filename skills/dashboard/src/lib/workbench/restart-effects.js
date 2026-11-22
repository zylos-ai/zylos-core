import { automaticRestartTypes, RESTART_EXIT_MS } from '../../../public/js/wb/timeline-rows.js';

export const restartAssociated = (group = 'restart.session_group IS event.session_group') => `EXISTS (
  SELECT 1 FROM runtime_events restart
  WHERE (${group}) AND restart.run_id = event.run_id
    AND restart.event_type IN (${automaticRestartTypes.map(type => `'${type}'`).join(',')})
    AND ROUND((julianday(event.timestamp) - julianday(restart.timestamp)) * 86400000) BETWEEN 0 AND ${RESTART_EXIT_MS}
)`;

export const isRestartExit = group => `(event.event_type = 'crash_detected' AND ${restartAssociated(group)})`;
