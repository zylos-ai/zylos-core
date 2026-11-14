export default {
  transform: {},
  testPathIgnorePatterns: [
    '<rootDir>/test/skill-command-arguments.test.js',
    '<rootDir>/test/diagram-browser.integration.test.js',
    '<rootDir>/test/diagram-components.integration.test.js',
    '<rootDir>/test/fleet-summary-refresh.integration.test.js',
    '<rootDir>/test/component-shard-hooks.integration.test.js',
    '<rootDir>/test/dashboard-stale-status.integration.test.js',
    '<rootDir>/test/router-stale-state.integration.test.js',
    '<rootDir>/test/supervisor-reclaim-deferral.integration.test.js',
    '/node_modules/',
    '<rootDir>/test/dashboard-readiness.integration.test.js',
    '<rootDir>/test/group-deletion.integration.test.js',
    '<rootDir>/test/group-deletion-storage.integration.test.js',
    // Node test-runner file; run by scripts/run-node-tests.js.
    '<rootDir>/test/test-location.test.js',
    '<rootDir>/test/reference-memory-templates.test.js',
    '<rootDir>/test/owned-tree-deletion-policy.test.js',
    '<rootDir>/test/owned-removal-callers.integration.test.js',
    '<rootDir>/test/test-environment-cleanup.test.js',
    '<rootDir>/test/history-reminders.integration.test.js',
    '<rootDir>/test/chat-quote.integration.test.js',
    '<rootDir>/test/origin-conversation.integration.test.js',
    '<rootDir>/test/web-console-process.integration.test.js',
    '<rootDir>/test/web-console-caddy.integration.test.js',
    '<rootDir>/test/single-upgrade-check.integration.test.js',
    '<rootDir>/test/session-release.integration.test.js',
  ],
  globalSetup: '<rootDir>/scripts/jest-global-setup.js',
  globalTeardown: '<rootDir>/scripts/jest-global-teardown.js',
  // Jest covers test/ and the mode-switch integration entries placed beside
  // activity-monitor. The Node runner excludes those two Jest entries.
  testMatch: [
    '<rootDir>/test/**/*.test.js',
    '<rootDir>/skills/activity-monitor/scripts/__tests__/mode-switch-admission.integration.test.js',
    '<rootDir>/skills/activity-monitor/scripts/__tests__/mode-switch-followup.integration.test.js',
  ],
};
