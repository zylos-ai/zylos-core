export default {
  transform: {},
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/test/group-deletion.integration.test.js',
    '<rootDir>/test/group-deletion-storage.integration.test.js',
    // Node test-runner file; run by scripts/run-node-tests.js.
    '<rootDir>/test/test-location.test.js',
    '<rootDir>/test/reference-memory-templates.test.js',
    '<rootDir>/test/history-reminders.integration.test.js',
    '<rootDir>/test/chat-quote.integration.test.js',
    '<rootDir>/test/origin-conversation.integration.test.js',
    '<rootDir>/test/web-console-process.integration.test.js',
    '<rootDir>/test/web-console-caddy.integration.test.js',
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
