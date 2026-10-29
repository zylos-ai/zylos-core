import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createRedactionWorker } from "../src/lib/redaction/worker-client.js";
import { KnownValues } from "../src/lib/redaction/layers/known-values.js";
import { keynameSpans } from "../src/lib/redaction/layers/keyname.js";
import { redact } from "../src/lib/redaction/engine.js";

const exec = promisify(execFile);
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

async function writeMutant(relative, mutate) {
  const url = new URL(relative, import.meta.url);
  const original = await readFile(url, "utf8");
  const mutation = mutate(original);
  assert.notEqual(
    mutation,
    original,
    "negative control must change production source",
  );
  const source = mutation.replace(
    /from '(\.\/[^']+)'/g,
    (_, dependency) => `from '${new URL(dependency, url).href}'`,
  );
  const directory = await mkdtemp(path.join(tmpdir(), "redaction-r1-mutant-"));
  const file = path.join(directory, "mutant.mjs");
  await writeFile(file, source);
  return pathToFileURL(file).href;
}

test("negative controls: each reverted scanner anchor exceeds the isolated child deadline", async () => {
  const layer = "../src/lib/redaction/layers/keyname.js";
  const cases = [
    {
      name: "pair start",
      before: String.raw`(?<![\w.-])`,
      after: String.raw`\b`,
      token: "a.",
    },
    {
      name: "URL scheme start",
      before: String.raw`(?<![a-z\d+.-])`,
      after: String.raw`\b`,
      token: "a-",
    },
    {
      name: "query delimiter",
      before: String.raw`[^=&#?\s]+`,
      after: String.raw`[^=&#\s]+`,
      token: "?a",
    },
  ];
  for (const fixture of cases) {
    const mutant = await writeMutant(layer, (source) =>
      source.replace(fixture.before, fixture.after),
    );
    const script = (url) =>
      `import {keynameSpans} from ${JSON.stringify(url)}; const text=${JSON.stringify(fixture.token)}.repeat(262144); if(keynameSpans(text).length) process.exit(2); console.log('completed');`;
    const baseline = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script(new URL(layer, import.meta.url).href),
      ],
      { timeout: 2000 },
    );
    assert.equal(baseline.stdout.trim(), "completed");
    await assert.rejects(
      exec(process.execPath, ["--input-type=module", "-e", script(mutant)], {
        timeout: 1500,
      }),
      (error) => {
        assert.equal(error.killed, true, fixture.name);
        assert.equal(error.signal, "SIGTERM", fixture.name);
        return true;
      },
    );
  }
});

test("negative controls: removing either L1 minimum length or value filter scrubs ordinary content", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "redaction-r1-known-"));
  await writeFile(
    path.join(directory, ".env"),
    "SHORT_TOKEN=small\nNUMBER_TOKEN=1234567890123\nREAL_TOKEN=actual-private-value\n",
  );
  const baseline = new KnownValues(directory);
  await baseline.refresh();
  const ordinary = "small 1234567890123";
  assert.equal(
    redact(ordinary, { knownValues: baseline.values }).text,
    ordinary,
  );
  assert.equal(
    redact("actual-private-value", { knownValues: baseline.values }).count,
    1,
  );
  for (const fragment of [
    "value.length >= 8 && ",
    " && isCredentialValue(value)",
  ]) {
    const url = await writeMutant(
      "../src/lib/redaction/layers/known-values.js",
      (source) => source.replace(fragment, ""),
    );
    const { KnownValues: Mutant } = await import(url);
    const known = new Mutant(directory);
    await known.refresh();
    assert.notEqual(
      redact(ordinary, { knownValues: known.values }).text,
      ordinary,
      fragment,
    );
  }
});

test("negative control: broad session/key/auth matching destroys ordinary metadata", async () => {
  const url = await writeMutant(
    "../src/lib/redaction/layers/keyname.js",
    (source) =>
      source.replace("  /(?:password|", "  /(?:session|key|auth|password|"),
  );
  const mutant = await import(url);
  for (const text of [
    "session_id=2a1fe8c0-828f-4d83-b18b-24cbcb02319b",
    "session_name=review-dashboard-history",
    "key=role",
    "auth=enabled",
  ]) {
    assert.deepEqual(keynameSpans(text), []);
    assert.ok(mutant.keynameSpans(text).length > 0, text);
  }
  assert.ok(keynameSpans("session_token=actual-private-value").length > 0);
});
