/** Removed Dashboard interfaces have no compatibility aliases. */
export function isRetiredApiPath(pathname) {
  return /^\/api\/(?:state|restart-status|session-mode|instance-status|system|summary|communication|timeline|metrics(?:\/.*)?|actions(?:\/.*)?|agent\/name|settings|chat\/settings)$/.test(pathname)
    || /^\/api\/workbench(?:\/|$)/.test(pathname);
}
