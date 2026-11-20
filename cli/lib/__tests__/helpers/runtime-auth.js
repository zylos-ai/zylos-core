import { getRuntime, findRuntime } from '../../runtime/index.js';

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

export function runtimeWithClaudeStatus(authenticated) {
  return async id => {
    const runtime = await getRuntime(id);
    if (id !== 'claude') return runtime;
    return {
      ...runtime,
      auth: {
        ...runtime.auth,
        initOptionsFromEnv: (opts, ctx) => runtime.auth.initOptionsFromEnv(opts, { ...ctx, authenticated }),
      },
    };
  };
}
