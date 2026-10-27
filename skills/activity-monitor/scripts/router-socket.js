import { loadCoreModule } from './core-modules.js';
import { StringDecoder } from 'node:string_decoder';
const { assertSessionGroup } = await loadCoreModule('session-group-paths.js');

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

/** Each connection consumes exactly one line; disconnects do not cancel durable work. */
export function createSupervisorConnectionHandler({ admission, router, readRun, readMode,
  onDelivered = () => {}, onHealthEvents = () => {}, isOpen = () => true, log = () => {} } = {}) {
  const pendingRequests = new Set();
  const handler = socket => {
    const reply = createRouterReply(socket, log);
    let data = ''; let consumed = false; const decoder = new StringDecoder('utf8');
    const consume = async chunk => {
      if (consumed) return;
      data += decoder.write(chunk);
      const end = data.indexOf('\n');
      if (end < 0) return;
      consumed = true;
      let request;
      try { request = JSON.parse(data.slice(0, end)); }
      catch { reply({ requestId: null, ok: false, code: 'invalid_request' }); return; }
      if (!request || typeof request !== 'object' || Array.isArray(request)) { reply({ requestId: null, ok: false, code: 'invalid_request' }); return; }
      try {
        if (['route','health_events_ready','notify_delivered'].includes(request.type) && !isOpen()) { socket.destroy(); return; }
        if (request.type === 'route') { reply(await router.route(request)); return; }
        if (request.type === 'health_events_ready') {
          if (request.version !== 1 || typeof request.requestId !== 'string' || !request.requestId) { reply({ ok: false, code: 'invalid_request' }); return; }
          await onHealthEvents(request);
          reply({ version: 1, type: 'ack', requestId: request.requestId }); return;
        }
        if (request.type === 'notify_delivered') {
          if (![1, 2].includes(request.version) || typeof request.requestId !== 'string' || !request.requestId) { reply({ ok: false, code: 'invalid_request' }); return; }
          if (request.version === 2) {
            if (request.sessionGroup !== null) assertSessionGroup(request.sessionGroup);
            if (typeof request.runId !== 'string' || !request.runId || typeof request.runtime !== 'string'
                || !Number.isSafeInteger(request.pastedAt) || request.pastedAt < 0) { reply({ ok: false, code: 'invalid_request' }); return; }
          }
          const group = request.version === 2 ? request.sessionGroup : ((await readMode()).mode === 'multi' ? 'origin' : null);
          const live = await readRun(group);
          if (live && (request.version === 1 || (live.runId === request.runId && live.runtime === request.runtime))) {
            if (request.version === 1 || Number.isSafeInteger(request.pastedAt)) {
              await onDelivered({ ...request, pastedAt: request.version === 1 ? request.deliveredAt : request.pastedAt,
                sessionGroup: group, runId: live.runId, runtime: live.runtime });
            }
          } else log('Ignoring stale delivery notification');
          reply({ version: 1, type: 'ack', requestId: request.requestId }); return;
        }
        reply(await admission.handle(request));
      } catch (error) {
        log(`Supervisor request failed: ${error.code || error.message}`);
        if (request.type === 'route') reply({ version: request.version, requestId: request.requestId, recovered: false,
          health: 'unavailable', reason: 'message_router_error', userMessage: 'I am temporarily unavailable. Please try again shortly.' });
        else if (['invalid_request', 'SESSION_GROUP_INVALID'].includes(error.code)) reply({ ok: false, code: 'invalid_request' });
        else socket.destroy(); // Do not falsely report an uncommitted refusal after an uncertain write.
      }
    };
    socket.on('data', chunk => {
      const pending=consume(chunk);
      pendingRequests.add(pending);
      pending.finally(()=>pendingRequests.delete(pending)).catch(error=>log(`Supervisor request failed: ${error.code || error.message}`));
    });
  };
  handler.drain=async()=>{
    while(pendingRequests.size)await Promise.allSettled([...pendingRequests]);
  };
  return handler;
}
