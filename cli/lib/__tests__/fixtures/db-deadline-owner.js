export const SUPPORTED_SCHEMA_VERSION=1;
export const supportsNewDatabase=true;
export const TABLES={};

export function inspectSchema() {
  if(process.env.DB_DEADLINE_BLOCK_STEP==='check') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
  }
  return {version:0,extensions:{tables:[],columns:[]}};
}
