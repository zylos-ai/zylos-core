import { SECRET_PATTERN } from '../dashboard-secret-pattern.js';
export function dashboardSpans(text) {
  return [...text.matchAll(new RegExp(SECRET_PATTERN.source.replaceAll('\\b', ''), 'gi'))].map(
    (m) => {
      const bearer = /^Bearer\s+/i.exec(m[0]);
      return {
        start: m.index + (bearer?.[0].length || 0),
        end: m.index + m[0].length,
        ruleId: 'dashboard-credential',
        label: 'Dashboard credential',
      };
    },
  );
}
