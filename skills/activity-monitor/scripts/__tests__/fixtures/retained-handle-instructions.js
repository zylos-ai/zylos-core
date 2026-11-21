// Resolve the real implementation while retaining a handle past protocol output.
setInterval(() => {}, 1000);
export async function getRuntime() {
  return (await import('../../../../../cli/lib/runtime/agy/index.js')).default;
}
