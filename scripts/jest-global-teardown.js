export default function teardown() {
  globalThis.zylosTestEnvironment.cleanup();
  delete globalThis.zylosTestEnvironment;
}
