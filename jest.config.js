export default {
  transform: {},
  globalSetup: '<rootDir>/scripts/jest-global-setup.js',
  globalTeardown: '<rootDir>/scripts/jest-global-teardown.js',
  // Jest covers the legacy suite under test/. npm test also runs a small
  // targeted node:test set for the Codex runtime follow-up fixes.
  testMatch: ['<rootDir>/test/**/*.test.js'],
};
