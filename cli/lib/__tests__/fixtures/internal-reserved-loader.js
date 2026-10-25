// Keep real target parsing but replace GitHub I/O with a fixed local registry.
export async function load(url, context, nextLoad) {
  if (url.endsWith('/cli/lib/github.js')) return {format:'module',shortCircuit:true,source:`
    export const fetchRawFile = () => JSON.stringify({components:{internal:{repo:'fixture/zylos-internal'},void:{repo:'fixture/zylos-void'},ordinary:{repo:'fixture/zylos-ordinary'}}});
    export const fetchLatestTag = () => 'v1.0.0';
    export const getGitHubToken = () => null;
    export const sanitizeError = value => String(value);
    export const withRateLimitRetrySync = action => action();
  `};
  return nextLoad(url,context);
}
