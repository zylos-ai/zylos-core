import { updateConfigStore } from '../../config-store.js';

const payload = JSON.parse(process.argv[2]);
updateConfigStore(payload.configFile, payload.update, {
  faultInjector: (stage) => {
    if (stage === payload.crashAt) process.kill(process.pid, 'SIGKILL');
  },
});
