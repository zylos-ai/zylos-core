import fs from 'node:fs';
import path from 'node:path';

// Hold the actual hook at its final media readability check, after its
// read-only connections opened and queries completed. No product code changes.
const access = fs.accessSync;
let signalled = false;
fs.accessSync = function (file, mode) {
  const result = access.call(this, file, mode);
  if (!signalled && typeof file === 'string' && file.startsWith(process.env.ATTACHMENT_HOOK_MEDIA + path.sep)
      && mode === fs.constants.R_OK) {
    signalled = true;
    fs.writeFileSync(process.env.ATTACHMENT_HOOK_READY, 'ready');
    const deadline = performance.now() + 3000;
    while (!fs.existsSync(process.env.ATTACHMENT_HOOK_RELEASE)) {
      if (performance.now() >= deadline) throw new Error('Hook reader fixture release timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return result;
};
