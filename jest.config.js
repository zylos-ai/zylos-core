export default {
  transform: {},
  // Jest covers the legacy suite under test/. npm test also runs node:test
  // suites from cli/lib/**/__tests__ and skills/**/scripts/__tests__.
  testMatch: ['<rootDir>/test/**/*.test.js'],
};
