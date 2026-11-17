import { loadCoreModule } from './core-modules.js';

export const { SupervisorServerHealth, DEFAULT_ALERT_DESTINATION } = await loadCoreModule('supervisor-server-health.js');
