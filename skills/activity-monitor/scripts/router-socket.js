// Hook wake clients have short deadlines. A peer disconnect must never turn
// an asynchronous IPC write error into an uncaught AM process exception.
export function createRouterReply(socket, log = () => {}) {
  let completed = false;
  socket.on('error', () => {
    completed = true;
    socket.destroy();
    log('MessageRouter IPC peer disconnected; durable work retained');
  });
  socket.once('close', () => { completed = true; });
  return value => {
    if (completed || socket.destroyed || socket.writableEnded) return false;
    completed = true;
    try {
      socket.end(`${JSON.stringify(value)}\n`);
      return true;
    } catch {
      socket.destroy();
      log('MessageRouter IPC reply unavailable; durable work retained');
      return false;
    }
  };
}
