export default {
  transform: {},
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
