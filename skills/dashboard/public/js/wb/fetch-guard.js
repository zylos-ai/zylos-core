export function createFetchGuard(){let generation=0;return {next:()=>++generation,current:gen=>gen===generation,invalidate:()=>++generation};}
export function apiError(payload){return typeof payload?.error==='string'?payload.error:payload?.error?.message??payload?.error?.code??'internal_error';}
