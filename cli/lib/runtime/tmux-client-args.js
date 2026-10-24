/** Keep structured tmux output intact even when services have no UTF-8 locale. */
export function tmuxClientArgs({ socketPath, socketName } = {}) {
  if (socketPath && socketName) throw new TypeError('Choose one tmux socket');
  return ['-u', ...(socketPath ? ['-S', socketPath] : socketName ? ['-L', socketName] : [])];
}
