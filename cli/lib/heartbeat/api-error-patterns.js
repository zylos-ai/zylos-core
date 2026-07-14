// Fatal runtime errors that can leave a session stuck in an unusable context.
// Keep these specific to CLI/runtime error displays to avoid matching normal
// conversation text.
const API_ERROR_PATTERNS = [
  /API\s*Error:\s*\d{3}/,                                  // "APIError: 400 ..." or "API Error: 400 ..."
  /\b(400|422)\b.*(?:bad request|invalid request)/i,       // "400 Bad Request"
  /invalid_request_error/,                                  // Anthropic error type
  /overloaded_error/,                                       // Anthropic overloaded
  /output blocked by content filtering policy/i,            // content filter block (needs session restart)
  /an image in the conversation exceeds the dimension limit for many-image requests/i,
  /dimension limit for many-image requests\s*\(\s*2000px\s*\)/i,
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
