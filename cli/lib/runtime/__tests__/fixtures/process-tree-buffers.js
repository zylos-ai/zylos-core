// Fresh-process probe: one runtime recognition through the real process-tree reader,
// reporting the largest growth of in-use ArrayBuffer memory while it runs.
import { readProcessTree, readTargetRuntime } from '../../session-target.js';

const pid = Number(process.argv[2]);
let peak = 0, sampling = true;
const base = process.memoryUsage().arrayBuffers;
const sample = () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); if (sampling) setImmediate(sample); };
sample();
const observed = await readTargetRuntime({ connection: { command: async () => `${pid}\n` },
  paneId: '%1', rawF2: {}, readProcessTree });
sampling = false;
sample();
process.stdout.write(JSON.stringify({ observed, peak }));
