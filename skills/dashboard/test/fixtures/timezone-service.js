import fs from 'node:fs';
import path from 'node:path';

// Match the real service startup boundaries, without launching their daemons.
// Scheduler startScheduler() assigns its product reader once at daemon.js:8;
// Web Console captures parsed .env once at server.js:77 for its timezone API.
let tz = process.env.TZ, source = 'process.env.TZ';
if (process.env.fixture_name === 'scheduler') {
  const { loadTimezone } = await import(process.env.fixture_timezone_module);
  process.env.TZ = loadTimezone();
  tz = process.env.TZ; source = 'scheduler.startupTimezone';
} else if (process.env.fixture_name === 'web-console') {
  const { parse } = await import(process.env.fixture_dotenv_module);
  const env = parse(fs.readFileSync(path.join(process.env.ZYLOS_DIR, '.env'), 'utf8'));
  tz = env.TZ || null; source = 'web-console.startupEnv';
}
function publish() {
  fs.writeFileSync(path.join(process.env.ZYLOS_DIR, `${process.env.fixture_name}.json`),
    JSON.stringify({ pid: process.pid, tz, processTz: process.env.TZ, source, sampledAt: Date.now() }));
}
publish();
// One overwritten receipt per service: no output or result accumulation. The
// private PM2 daemon and its children are killed by the owning test lifecycle.
setInterval(publish, 100);
