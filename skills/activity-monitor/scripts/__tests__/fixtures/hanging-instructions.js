// An unavailable optional Core module retains a handle until the hook deadline.
await new Promise(() => setInterval(() => {}, 1000));
export const getRuntime = async () => ({ instructions: { sessionStartInjection: () => '' } });
