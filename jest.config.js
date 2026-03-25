export default {
  transform: {},
  // Jest covers the legacy suite under test/. npm test also runs a small
  // targeted node:test set for the Codex runtime follow-up fixes.
  testMatch: ['<rootDir>/test/**/*.test.js'],
};
