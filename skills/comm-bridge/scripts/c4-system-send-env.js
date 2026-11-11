/** System notifications and resident services have no runtime session identity. */
export function systemSendEnvironment(env = process.env, { notice = false } = {}) {
  const childEnv = { ...env };
  delete childEnv.ZYLOS_RUN_ID;
  delete childEnv.ZYLOS_SESSION_GROUP;
  delete childEnv.ZYLOS_SYSTEM_SEND;
  if (notice) childEnv.ZYLOS_SYSTEM_SEND = '1';
  return childEnv;
}
