import { parentPort } from 'node:worker_threads';
import { redact, UNAVAILABLE } from './engine.js';
parentPort.on('message', ({ id, text, options }) => {
  try {
    parentPort.postMessage({ id, result: redact(text, options) });
  } catch {
    parentPort.postMessage({
      id,
      result: { text: UNAVAILABLE, count: 0, kinds: [], failed: true },
    });
  }
});
