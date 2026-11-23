import { UNSUPPORTED } from '../contract.js';
import { detectApiErrorText } from '../shared/api-error-patterns.js';

const AUTH_FAILURE_PATTERNS = [
  /authentication failed/i,
  /not logged in/i,
  /invalid api key/i,
  /unauthorized/i,
];

/** Pure screen facts; recovery priority and cooldown belong to the supervisor. */
function matchScreen(text) {
  const pane = typeof text === 'string' ? text : '';
  const auth = AUTH_FAILURE_PATTERNS.map(p => pane.match(p)).find(Boolean);
  const rate = null;
  return {
    rateLimit: rate ? {detected:true, pattern:rate[0]} : {detected:false},
    authFailure: auth ? {detected:true, pattern:auth[0]} : {detected:false},
    apiError: detectApiErrorText(pane),
  };
}

export const health = Object.freeze({
  screen: Object.freeze({ match: matchScreen }),
  hookHealth: UNSUPPORTED,
  toolWatchdog: UNSUPPORTED,
  noticeRules: UNSUPPORTED,
});
