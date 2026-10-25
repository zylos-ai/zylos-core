import { createTestEnvironment } from './test-environment.js';

export default function setup() {
  globalThis.zylosTestEnvironment = createTestEnvironment();
}
