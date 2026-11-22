export function isConversationApiPath(pathname) {
  return pathname === '/api/conversations' || pathname.startsWith('/api/conversations/');
}

export function isRetiredConversationApiPath(pathname) {
  return pathname === '/api/chat' || pathname.startsWith('/api/chat/');
}

/** Removed Dashboard interfaces have no compatibility aliases. */
export function isRetiredApiPath(pathname) {
  return isRetiredConversationApiPath(pathname) || /^\/api\/(?:state|restart-status|session-mode|instance-status|system|summary|communication|timeline|metrics(?:\/.*)?|actions(?:\/.*)?|agent\/name|settings)$/.test(pathname)
    || /^\/api\/workbench(?:\/|$)/.test(pathname);
}
