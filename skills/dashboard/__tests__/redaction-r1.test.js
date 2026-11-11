import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRedactionWorker } from "../src/lib/redaction/worker-client.js";

const failure = () => ({ failed: true });
async function workerFixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "redaction-r1-worker-"));
  const file = path.join(directory, "worker.mjs");
  await writeFile(
    file,
    `import { parentPort, threadId } from 'node:worker_threads';
parentPort.on('message', ({id,text,options}) => {
  if (text === 'hang') Atomics.wait(new Int32Array(options.gate), 0, 0);
  parentPort.postMessage({id,result:{text,threadId}});
});`,
  );
  return createRedactionWorker({
    workerURL: pathToFileURL(file),
    timeoutMs: 2000,
    failure,
    ...options,
  });
}

test("worker admits bursts beyond the former cap and processes them on one worker", async () => {
  const worker = await workerFixture();
  const gate = new SharedArrayBuffer(4);
  try {
    const warm = await worker.run("warm", {});
    const names = ["hang", ...Array.from({ length: 199 }, (_, i) => `queued-${i}`)];
    const pending = names.map((text) => worker.run(text, { gate }));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((r) => r.text), names);
    assert.ok(results.every((r) => r.threadId === warm.threadId));
    assert.equal((await worker.run("after-burst", {})).text, "after-burst");
  } finally {
    worker.close();
  }
});

test("close resolves active and queued jobs, is idempotent, and rejects future jobs", async () => {
  const worker = await workerFixture({ timeoutMs: 10000 });
  try {
    await worker.run("warm", {});
    const pending = [
      worker.run("hang", { gate: new SharedArrayBuffer(4) }),
      worker.run("queued", {}),
    ];
    worker.close();
    worker.close();
    assert.deepEqual(await Promise.all(pending), [failure(), failure()]);
    assert.deepEqual(await worker.run("after-close", {}), failure());
  } finally {
    worker.close();
  }
});

test("concurrent queue deadlines fail closed and a later job survives worker replacement", async () => {
  const worker = await workerFixture({ timeoutMs: 600 });
  try {
    const warm = await worker.run("warm", {});
    const first = worker.run("hang", { gate: new SharedArrayBuffer(4) });
    const second = worker.run("hang", { gate: new SharedArrayBuffer(4) });
    await delay(200);
    const later = worker.run("later", {});
    assert.deepEqual(await Promise.all([first, second]), [
      failure(),
      failure(),
    ]);
    const recovered = await later;
    assert.equal(recovered.text, "later");
    assert.notEqual(recovered.threadId, warm.threadId);
    assert.equal(
      (await worker.run("still-healthy", {})).threadId,
      recovered.threadId,
    );
  } finally {
    worker.close();
  }
});
