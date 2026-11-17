export function migrateDatabase() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
}
