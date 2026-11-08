import fs from 'node:fs';
import path from 'node:path';

fs.writeFileSync(path.join(process.env.ZYLOS_DIR, `${process.env.fixture_name}.json`),
  JSON.stringify({ pid: process.pid, tz: process.env.TZ }));
setInterval(() => {}, 1000);
