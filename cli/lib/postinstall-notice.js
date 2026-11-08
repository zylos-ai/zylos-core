import fs from 'node:fs';

export const INITIALIZATION_NOTICE = '\nThis machine has already been initialized. Run "zylos init" to finish service, dependency and data initialization. For normal upgrades, use "zylos upgrade --self".\n';

export function printInitializationNotice({ stdout = process.stdout, ttyPath = '/dev/tty' } = {}) {
  if (!stdout.isTTY) {
    let fd;
    try {
      // npm captures successful hook output; a controlling terminal remains visible.
      fd = fs.openSync(ttyPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY);
      fs.writeSync(fd, INITIALIZATION_NOTICE);
      return;
    } catch {
      // Missing terminals and failed writes must not fail or delay installation.
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best-effort terminal cleanup */ }
      }
    }
  }
  stdout.write(INITIALIZATION_NOTICE);
}
