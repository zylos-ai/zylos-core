import fs from 'node:fs';
import path from 'node:path';
import { tmuxError } from './tmux-protocol.js';

export const isTmuxDirectoryError = error => /^TMUX_DIR_/.test(error?.code ?? '');

/** Validate before every client; an explicit socket prevents tmux's /tmp fallback. */
export function tmuxClientArgs({ socketPath, socketName, utf8 = true } = {}, env = process.env) {
  if (socketPath && socketName) throw new TypeError('Choose one tmux socket');
  if (env.TMUX_TMPDIR) {
    let root = env.TMUX_TMPDIR;
    const uid = process.getuid();
    const check = (directory, privateDirectory = false) => {
      let stat;
      try { stat = privateDirectory ? fs.lstatSync(directory) : fs.statSync(directory); }
      catch (error) {
        throw tmuxError(error.code === 'ENOENT' ? 'TMUX_DIR_MISSING' : 'TMUX_DIR_UNAVAILABLE',
          `TMUX_TMPDIR directory unavailable: ${directory}`, error.code);
      }
      if (!stat.isDirectory() || (privateDirectory && (stat.uid !== uid || (stat.mode & 0o007)))) {
        throw tmuxError('TMUX_DIR_UNSAFE', `TMUX_TMPDIR directory ownership or permissions invalid: ${directory}`);
      }
    };
    if (!path.isAbsolute(root)) throw tmuxError('TMUX_DIR_UNSAFE', 'TMUX_TMPDIR must be an absolute directory');
    try { root = fs.realpathSync(root); }
    catch (error) {
      throw tmuxError(error.code === 'ENOENT' ? 'TMUX_DIR_MISSING' : 'TMUX_DIR_UNAVAILABLE',
        `TMUX_TMPDIR directory unavailable: ${root}`, error.code);
    }
    check(root);
    const directory = path.join(root, `tmux-${uid}`);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw tmuxError('TMUX_DIR_UNAVAILABLE', `Cannot prepare TMUX_TMPDIR socket directory: ${directory}`, error.code); }
    check(directory, true);
    socketPath ||= path.join(directory, socketName || 'default');
    socketName = undefined;
  }
  return [...(utf8 ? ['-u'] : []), ...(socketPath ? ['-S', socketPath] : socketName ? ['-L', socketName] : [])];
}

export function tmuxClientEnvironment() {
  const env = { ...process.env };
  for (const key of ['ZYLOS_RUN_ID', 'ZYLOS_MODEL_CONFIG', 'ZYLOS_SESSION_GROUP']) delete env[key];
  return env;
}
