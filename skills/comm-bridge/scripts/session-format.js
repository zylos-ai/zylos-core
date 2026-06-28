/**
 * Shared formatter for session-start context injection.
 *
 * Both memory injection (zylos-memory/session-start-inject.js) and C4 session
 * init (comm-bridge/c4-session-init.js) emit labeled blocks into the same
 * stdout stream consumed at session start. Historically each script had its
 * own ad-hoc style (`=== LABEL ===` header-only vs `[Bracket Label]`), so the
 * combined injection read inconsistently. This module is the single source of
 * truth for that framing so every section looks the same.
 *
 * The orchestrator (activity-monitor/session-start-orchestrator.js) also uses
 * it to render visible failure notices when a context step fails.
 */

/**
 * Wrap a labeled section with a matching header and footer.
 *
 * @param {string} label   - Section label, rendered verbatim. Convention: UPPERCASE.
 * @param {string} content - Section body. Trimmed; nullish/empty renders as `(empty)`.
 * @returns {string} `=== LABEL ===\n<content>\n=== END LABEL ===`
 */
export function formatSection(label, content) {
  const body = (content == null ? '' : String(content)).trim();
  return `=== ${label} ===\n${body.length > 0 ? body : '(empty)'}\n=== END ${label} ===`;
}
