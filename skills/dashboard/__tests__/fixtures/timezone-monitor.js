import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../../activity-monitor/scripts/monitor.js';
import { startSupervisor } from '../../../activity-monitor/scripts/supervisor-main.js';
import { SupervisorScenes } from '../../../activity-monitor/scripts/supervisor-scenes.js';
const scenes = new SupervisorScenes({ env: process.env, readMode: () => ({ mode: 'multi' }) });
let rounds = 0;
await main({ start: () => startSupervisor({ async afterRound() {
  fs.writeFileSync(path.join(process.env.ZYLOS_DIR, 'activity-monitor.json'), JSON.stringify({
    scene: await scenes.observeGroup('preserved'), pid: process.pid, tz: process.env.TZ, rounds: ++rounds, sampledAt: Date.now(),
  }));
} }) });
