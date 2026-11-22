import { createServer } from '../../src/index.js';

const server = createServer();
process.once('disconnect', () => {
  server.closeAllConnections();
  server.close();
});
server.listen(0, '127.0.0.1', () => {
  process.send({ origin: `http://127.0.0.1:${server.address().port}` });
});
