import { UNSUPPORTED } from '../contract.js';
import { HEALTH_NOTICE_RULES } from '../shared/health-notice-rules.js';

export const health = Object.freeze({
  screen: UNSUPPORTED,
  hookHealth: Object.freeze({ hookFailureHasPromptId: false }),
  toolWatchdog: UNSUPPORTED,
  noticeRules: HEALTH_NOTICE_RULES,
});
