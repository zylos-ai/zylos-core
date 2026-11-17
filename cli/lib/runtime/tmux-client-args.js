/** Keep structured tmux output intact even when services have no UTF-8 locale. */
export function tmuxClientArgs({ socketPath, socketName } = {}) {
  if (socketPath && socketName) throw new TypeError('Choose one tmux socket');
  return ['-u', ...(socketPath ? ['-S', socketPath] : socketName ? ['-L', socketName] : [])];
}

/** Server-global environment must not inherit the calling session's identity. */
export function tmuxClientEnvironment() {
  const env = { ...process.env };
  for (const key of ['ZYLOS_RUN_ID', 'ZYLOS_MODEL_CONFIG', 'ZYLOS_SESSION_GROUP']) delete env[key];
  return env;
}
