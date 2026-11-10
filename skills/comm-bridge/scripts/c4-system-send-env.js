/** System notifications and resident services have no runtime session identity. */
export function systemSendEnvironment(env = process.env) {
  const childEnv = { ...env };
  delete childEnv.ZYLOS_RUN_ID;
  delete childEnv.ZYLOS_SESSION_GROUP;
  return childEnv;
}
