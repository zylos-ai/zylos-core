import { workerData } from 'node:worker_threads';
const control = new Int32Array(workerData.shared, 0, 2);
const bytes = new Uint8Array(workerData.shared, 8);
let result;
try {
  const { createSessionReader } = await import('./session-state-reader-async.js');
  const reader = createSessionReader();
  result = { value: await reader[workerData.method](...workerData.args) };
} catch (error) { result = { error: { message: error.message, code: error.code, cause: error.cause } }; }
let encoded = new TextEncoder().encode(JSON.stringify(result));
if (encoded.length > bytes.length) encoded = new TextEncoder().encode(JSON.stringify({ error: { message: 'Reader result exceeds size limit', code: 'READER_RESULT_TOO_LARGE' } }));
bytes.set(encoded);
Atomics.store(control, 1, encoded.length);
Atomics.store(control, 0, 1);
Atomics.notify(control, 0);
