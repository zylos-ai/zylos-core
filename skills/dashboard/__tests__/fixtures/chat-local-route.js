import { mock } from 'node:test';
import { VersionChecker } from '../../src/lib/version-checker.js';

// The route under test is the actual Dashboard server; prevent unrelated
// registry polling in this bounded, offline fixture.
mock.method(VersionChecker.prototype, 'start', () => {});
const { createServer } = await import('../../src/index.js');
const server = createServer();
server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ chatRouteOrigin: `http://127.0.0.1:${server.address().port}` }));
});
