import { Worker } from 'node:worker_threads';

// One reusable worker keeps regex execution off the HTTP event loop at every
// field size. A deadline covers both waiting and execution; a stuck worker is
// replaced before queued work resumes. Bursts wait instead of failing admission;
// each queued job retains its deadline. Only one worker executes at a time.
export function createRedactionWorker({ workerURL, timeoutMs, failure }) {
  let worker;
  let active;
  let sequence = 0;
  let closed = false;
  const queue = [];

  function retire() {
    const previous = worker;
    worker = undefined;
    if (previous) void previous.terminate();
  }

  function finish(job, result) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    if (active === job) active = undefined;
    else {
      const index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
    }
    job.resolve(result);
  }

  function startWorker() {
    const current = new Worker(workerURL);
    worker = current;
    current.on('message', (message) => {
      if (worker !== current || !active || message.id !== active.id) return;
      finish(active, message.result);
      pump();
    });
    const failed = () => {
      if (worker !== current) return;
      retire();
      if (active) finish(active, failure());
      pump();
    };
    current.on('error', failed);
    current.on('exit', failed);
  }

  function pump() {
    if (closed || active) return;
    if (queue.length === 0) {
      worker?.unref();
      return;
    }
    active = queue.shift();
    try {
      if (!worker) startWorker();
      worker.ref();
      worker.postMessage({ id: active.id, text: active.text, options: active.options });
    } catch {
      retire();
      finish(active, failure());
      pump();
    }
  }

  return {
    run(text, options) {
      if (closed)
        return Promise.resolve(failure());
      return new Promise((resolve) => {
        const job = { id: ++sequence, text, options, resolve, done: false };
        job.timer = setTimeout(() => {
          if (job.done) return;
          if (active === job) retire();
          finish(job, failure());
          pump();
        }, timeoutMs);
        queue.push(job);
        pump();
      });
    },
    close() {
      closed = true;
      retire();
      if (active) finish(active, failure());
      while (queue.length) finish(queue[0], failure());
    },
  };
}
