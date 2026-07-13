import fs from 'node:fs';

import { reconcileAssemblerSettingsFile } from '../../instruction-migration.js';

const [zylosDir, mode] = process.argv.slice(2);

reconcileAssemblerSettingsFile({
  zylosDir,
  apply: true,
  io: {
    renameSync(from, to) {
      if (mode === 'after') fs.renameSync(from, to);
      process.send?.({ boundary: mode });
      setInterval(() => {}, 1000);
    },
  },
});
