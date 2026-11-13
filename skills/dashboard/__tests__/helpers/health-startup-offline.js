import { EventEmitter } from 'node:events';
import https from 'node:https';
import { mock } from 'node:test';

// Keep the real main entry and its startup publisher intact. Only version
// checks leave the private loopback fixture, so fail those at the transport.
mock.method(https, 'get', () => {
  const request = new EventEmitter();
  queueMicrotask(() => request.emit('error', new Error('offline startup fixture')));
  return request;
});
