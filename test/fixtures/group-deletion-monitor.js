import fs from 'node:fs';
import path from 'node:path';
import { main } from '../../skills/activity-monitor/scripts/monitor.js';
import { startSupervisor } from '../../skills/activity-monitor/scripts/supervisor-main.js';
import { SupervisorScenes } from '../../skills/activity-monitor/scripts/supervisor-scenes.js';
const root = process.env.ZYLOS_DIR;
const activity = () => ({ state: fs.existsSync(path.join(root, 'busy')) ? 'working' : 'idle',
  idleSince: Date.now() - 60_000, activeSubagents: [] });
const scenes = new SupervisorScenes({ env: process.env, connectionOptions: { socketPath: process.env.GROUP_DELETION_TEST_SOCKET },
  readMode: () => ({ mode: 'multi' }), readActivity: activity, readUsage: () => 0 });
let rounds = 0;
await main({ start: () => startSupervisor({ scenes,
  checkAuth: async () => ({ status: 'success' }),
  // The fixture supplies activity facts; process identity, native transport,
  // lifecycle, stop and ending persistence remain production code.
  readSyncMarker: () => ({ held: false, stale: false }),
  machineTasks: { tick: async () => {}, stop: async () => {} },
  legacyStatus: { tick: async () => {}, close() {} },
  async afterRound() { fs.writeFileSync(path.join(root, 'monitor-round.json'), JSON.stringify({ pid: process.pid, rounds: ++rounds })); },
}) });
