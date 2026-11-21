import { HEALTH_NOTICE_RULES } from '../shared/health-notice-rules.js';
import { detectApiErrorText } from '../shared/api-error-patterns.js';

const RATE_LIMIT_PATTERNS = [
  /out of extra usage/i,
  /you[''’]re out of .* usage/i,
  /usage limit reached/i,
  /you[''’]ve hit your (?:\w+ )?limit/i,
];

const AUTH_FAILURE_PATTERNS = [
  /authentication_error/i,
  /auth(?:entication)? failed/i,
  /invalid api key/i,
  /unauthorized/i,
];

/** Pure screen facts; recovery priority and cooldown belong to the supervisor. */
function matchScreen(text) {
  const pane = typeof text === 'string' ? text : '';
  const auth = AUTH_FAILURE_PATTERNS.map(p => pane.match(p)).find(Boolean);
  const rate = RATE_LIMIT_PATTERNS.map(p => pane.match(p)).find(Boolean);
  return {
    rateLimit: rate ? {detected:true, pattern:rate[0]} : {detected:false},
    authFailure: auth ? {detected:true, pattern:auth[0]} : {detected:false},
    apiError: detectApiErrorText(pane),
  };
}

export { RATE_LIMIT_PATTERNS as _RATE_LIMIT_PATTERNS };

export const health = Object.freeze({
  screen: Object.freeze({ match: matchScreen }),
  hookHealth: Object.freeze({ hookFailureHasPromptId: true }),
  toolWatchdog: Object.freeze({ tools: Object.freeze(['WebFetch', 'WebSearch']), interruptKey: 'Escape' }),
  noticeRules: HEALTH_NOTICE_RULES,
});
