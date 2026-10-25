#!/usr/bin/env node
/** M4 observes and reconciles sessions; M1 exclusively owns process launch. */
import { startSupervisor } from './supervisor-main.js';

const service = await startSupervisor();
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void service.stop().then(() => process.exit(0));
  });
}
