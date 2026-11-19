import { findRuntime } from '../../runtime/index.js';

export async function runtimeAuthFixture(id, {
  findExecutable = () => `/fixture/bin/${id}`,
  auth = { checkAuth: () => ({ status: 'success' }) },
} = {}) {
  const runtime = await findRuntime(id);
  if (!runtime) return null;
  return {
    ...runtime,
    identity: { ...runtime.identity, findExecutable },
    auth: { ...runtime.auth, ...auth },
  };
}
