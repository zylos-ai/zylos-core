import path from 'node:path';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers/promises';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const load = name => import(pathToFileURL(path.join(repo, name)).href);
mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });

// A clock tick starts asynchronous observations. Wait for their I/O before
// acknowledging the tick so the parent can read the completed tmux trace.
const pending = new Set();
function track(target, method, matches = () => true) {
  const original = target[method];
  target[method] = function (...args) {
    const result = original.apply(this, args);
    if (matches(...args)) {
      pending.add(result);
      const done = () => pending.delete(result);
      result.then(done, done);
    }
    return result;
  };
}
const { CoreState } = await load('skills/dashboard/src/lib/core-state.js');
const { SystemCollector } = await load('skills/dashboard/src/lib/collectors/system-collector.js');
const { EventLoopMonitor } = await load('skills/dashboard/src/lib/event-loop-monitor.js');
track(CoreState.prototype, 'refresh');
track(SystemCollector.prototype, 'collect');
track(EventLoopMonitor.prototype, 'runTask', name => name === 'fleet.broadcast');
const warmup = SystemCollector.prototype.warmup;
SystemCollector.prototype.warmup = async function () {
  // Let warmup complete its initial sample and arm the 200 ms timer.
  const result = warmup.call(this);
  await Promise.all(pending);
  console.log('ACCEPTANCE_WARMUP_STARTED');
  await result;
  console.log('ACCEPTANCE_WARMUP_FINISHED');
};

const { SseHub } = await load('skills/dashboard/src/lib/sse.js');
const addClient = SseHub.prototype.addClient;
SseHub.prototype.addClient = function (res, ...args) {
  const client = addClient.call(this, res, ...args);
  res.once('close', () => console.log('ACCEPTANCE_STREAM_CLOSED'));
  return client;
};

const { VersionChecker } = await load('skills/dashboard/src/lib/version-checker.js');
VersionChecker.prototype.start = () => {};
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  args[0] = 0; // Production config defaults reject port 0; bind only an ephemeral fixture port.
  this.once('listening', () => console.log(`ACCEPTANCE_LISTEN=${this.address().port} ${Date.now()}`));
  return listen.apply(this, args);
};
process.env.pm_exec_path = path.join(repo, 'skills/dashboard/src/index.js');
await load('skills/dashboard/src/index.js');

for await (const line of createInterface({ input: process.stdin })) {
  const [step, milliseconds] = line.split(' ').map(Number);
  mock.timers.tick(milliseconds);
  await setImmediate();
  while (pending.size) await Promise.all(pending);
  // Release the coalesced SSE publication queued by the observation.
  mock.timers.tick(0);
  while (pending.size) await Promise.all(pending);
  console.log(`ACCEPTANCE_TICK=${step} ${Date.now()}`);
}
