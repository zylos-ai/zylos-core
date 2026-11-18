import assert from 'node:assert/strict';

/** Signs in through the real login form and returns the session cookie pair for later requests. */
export async function signIn(origin, password) {
  const response = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }),
    signal: AbortSignal.timeout(5000) });
  await response.text();
  assert.equal(response.status, 302);
  return response.headers.getSetCookie().find(cookie => cookie.startsWith('__Secure-zylos_dashboard_session=')).split(';')[0];
}
