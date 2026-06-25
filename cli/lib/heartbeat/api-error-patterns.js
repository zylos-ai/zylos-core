// Fatal runtime errors that can leave a session stuck in an unusable context.
// Keep these specific to CLI/runtime error displays to avoid matching normal
// conversation text.
const API_ERROR_PATTERNS = [
  // Claude Code displays "API Error: 400 ..." (with space) on recent versions;
  // older releases used "APIError: 400". Allow either form so the proactive
  // scan keeps firing if the chrome flips again.
  /API\s*Error:\s*\d{3}/,
  /\b(400|422)\b.*(?:bad request|invalid request)/i,      // "400 Bad Request"
  /invalid_request_error/,                                 // Anthropic error type
  /overloaded_error/,                                      // Anthropic overloaded
  /an image in the conversation exceeds the dimension limit for many-image requests/i,
  /dimension limit for many-image requests\s*\(\s*2000px\s*\)/i,
  // JSON-format Anthropic error: {"error":{"code":"400",...}} — catches cases
  // where the pretty error chrome is missing but the raw JSON leaks in.
  /"code"\s*:\s*"4\d{2}"/,
  // Stale model alias rejected — surfaced as the "Not supported model ..."
  // message after a Claude Code model-ID requirement change.
  /Not supported model/i,
];

/**
 * Detect fatal API/context errors in captured runtime pane text.
 *
 * @param {string} text
 * @returns {{ detected: boolean, pattern?: string }}
 */
export function detectApiErrorText(text) {
  if (!text) return { detected: false };

  for (const p of API_ERROR_PATTERNS) {
    const match = text.match(p);
    if (match) {
      return { detected: true, pattern: match[0] };
    }
  }
  return { detected: false };
}
