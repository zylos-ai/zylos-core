import { assertTestChildEnvironment, installTestChildGuard } from './test-child-guard.js';
import { useTestFileHome } from './test-environment.js';

assertTestChildEnvironment();
useTestFileHome();
// Explicit child environments can omit the Node test worker identifier.
process.env.ZYLOS_TEST_RUN = '1';
installTestChildGuard();
