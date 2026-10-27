import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  try { return !!argv1 && fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(importMetaUrl)); }
  catch { return false; }
}
