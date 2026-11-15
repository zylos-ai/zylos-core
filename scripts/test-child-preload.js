import { assertTestChildEnvironment, installTestChildGuard } from './test-child-guard.js';

assertTestChildEnvironment();
// Explicit child environments can omit the Node/Jest worker identifiers.
process.env.ZYLOS_TEST_RUN = '1';
installTestChildGuard();
