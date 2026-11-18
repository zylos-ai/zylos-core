/** Shared permission explanations for Dashboard writes and deletion safety checks. */
export function permissionErrorKey(code) {
  const keys = {
    not_allowed_via_fleet: 'wb.schedule.error.not_allowed_via_fleet',
    insufficient_scope: 'wb.schedule.error.insufficient_scope',
    unauthorized: 'wb.schedule.error.unauthorized',
    admin_required: 'wb.error.adminRequired',
    same_origin_required: 'wb.error.sameOriginRequired',
    local_cookie_required: 'wb.error.localCookieRequired',
    remote_deletion_forbidden: 'wb.error.remoteDeletionForbidden',
    origin_deletion_forbidden: 'wb.error.originDeletionForbidden',
  };
  return Object.hasOwn(keys, code) ? keys[code] : null;
}
