import { mock } from 'node:test';

// A fixed clock shared with the parent scheduler iteration; all CLI code is imported normally.
mock.timers.enable({ apis: ['Date'], now: Number(process.env.SCHEDULER_TEST_TIME) });
await import('../../cli.js');
