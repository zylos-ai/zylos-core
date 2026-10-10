import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DATABASES = [
  {source:'comm-bridge/c4.db',owner:'comm-bridge',schema:'scripts/c4-schema.js'},
  {source:'scheduler/scheduler.db',owner:'scheduler',schema:'scripts/schema.js'},
  {source:'web-console/web-console.db',owner:'web-console',schema:'scripts/schema.js'},
];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function driver(input, item) {
  const root=input.schemaRoot || path.join(input.zylosDir,'.claude','skills');
  const req = createRequire(path.join(root,item.owner,'package.json'));
  // Snapshot verification uses the frozen independent closure. Compatibility
  // preflight must load the actual owner's native dependency under this Node.
  return req(input.action==='offline-preflight' ? 'better-sqlite3' : (input.driverPath || 'better-sqlite3'));
}
function missing(file) {
  if (fs.existsSync(file)) return false;
  if (['-wal','-shm'].some(s => fs.existsSync(file+s))) throw new Error(`Orphan SQLite sidecar: ${file}`);
  return true;
}
function inspectConnection(db) {
  const checks=db.pragma('integrity_check');
  if(checks.length!==1 || Object.values(checks[0])[0]!=='ok') throw new Error('integrity_check failed');
  return {userVersion:db.pragma('user_version',{simple:true}),integrityCheck:'ok'};
}
function withStandaloneReadonly(Database, file, expectedHash, inspect) {
  // Private snapshots are normalized to DELETE before their hash is recorded.
  // Read them directly; no disposable database copy or WAL sidecar is needed.
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid standalone database: ${file}`);
  for (const suffix of ['-wal', '-shm']) {
    try { fs.lstatSync(file + suffix); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Unexpected standalone SQLite sidecar: ${file + suffix}`);
  }
  if (hash(file) !== expectedHash) throw new Error(`Standalone database hash mismatch: ${file}`);
  // Reject a WAL header before opening: the driver could create sidecars even
  // through a readonly connection to an older, non-normalized snapshot.
  const header = Buffer.alloc(20), fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, header, 0, header.length, 0); }
  finally { fs.closeSync(fd); }
  if (header[18] !== 1 || header[19] !== 1) throw new Error(`Standalone database is not normalized: ${file}`);
  const db = new Database(file, {readonly:true, fileMustExist:true, timeout:5000});
  try {
    db.exec('BEGIN');
    return inspect(db);
  } finally {
    try { if (db.inTransaction) db.exec('ROLLBACK'); }
    finally { db.close(); }
  }
}

function inspect(Database, file, expectedHash=hash(file)) {
  return withStandaloneReadonly(Database, file, expectedHash, inspectConnection);
}
async function ownerSchema(input,item) {
  const schemaPath=path.join(input.schemaRoot || path.join(input.zylosDir,'.claude','skills'),item.owner,item.schema);
  try {
    const mod=await import(pathToFileURL(schemaPath));
    if(typeof mod.inspectSchema!=='function'||typeof mod.supportsNewDatabase!=='boolean') throw new Error('missing pure schema inspection contract');
    return mod;
  }catch(error){throw new Error(`Incompatible owner schema code ${item.owner}: ${error.message}`);}
}
export async function execute(input) {
  if(!['probe','snapshot','verify','offline-preflight'].includes(input.action)) throw new Error(`Unknown action: ${input.action}`);
  if(input.action==='probe') {
    const Database=createRequire(import.meta.url)(input.driverPath); const db=new Database(':memory:');
    try {if(typeof db.backup!=='function') throw new Error('SQLite backup API unavailable');}finally{db.close();}
    return {ok:true};
  }
  const rows=[];
  for(const item of DATABASES) {
    const expected=input.manifest?.databases?.find(r=>r.source===item.source);
    const source=path.join(input.zylosDir,item.source);
    if(input.action==='verify') {
      if(!expected) throw new Error(`Missing manifest entry: ${item.source}`);
      if(expected.status==='missing') {rows.push({...expected});continue;}
      if(expected.status!=='backed_up'||path.basename(expected.file)!==expected.file) throw new Error('Invalid snapshot entry');
      const file=path.join(input.dbBackupDir,expected.file);
      if(fs.statSync(file).size!==expected.bytes||hash(file)!==expected.sha256) throw new Error(`Snapshot hash mismatch: ${file}`);
      const state=inspect(driver(input,item),file,expected.sha256);
      if(state.userVersion!==expected.userVersion) throw new Error('Snapshot user_version mismatch');
      rows.push({...expected,...state});continue;
    }
    if(missing(source)) {
      if(expected&&expected.status!=='missing') throw new Error(`Expected database absent: ${source}`);
      if(input.action==='offline-preflight') {
        const mod=await ownerSchema(input,item);
        if(!mod.supportsNewDatabase) throw new Error(`Owner cannot initialize missing database: ${item.owner}`);
        // Loading a pure module alone does not prove the actual Node/native
        // driver combination can perform the owner's first database creation.
        const Database=driver(input,item), memory=new Database(':memory:');
        try {mod.inspectSchema(memory,{allowNew:true});}finally{memory.close();}
      }
      rows.push({source:item.source,status:'missing',userVersion:null,file:null,bytes:0,sha256:null,integrityCheck:null});continue;
    }
    if(expected?.status==='missing') throw new Error(`Expected missing database exists: ${source}`);
    const Database=driver(input,item);
    if(input.action==='offline-preflight') {
      const mod=await ownerSchema(input,item);
      let state;
      if (input.standaloneRestored === true) {
        if (input.manifest?.status !== 'complete' || expected?.status !== 'backed_up' || typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('Missing standalone restored snapshot evidence');
        state = withStandaloneReadonly(Database, source, expected.sha256, db => {mod.inspectSchema(db); return inspectConnection(db);});
      } else {
        // Original/preinstall and active READY verification must see committed
        // live WAL data. Never treat those databases as standalone snapshots.
        const db=new Database(source,{readonly:true,fileMustExist:true,timeout:5000});
        try {db.exec('BEGIN');mod.inspectSchema(db);state=inspectConnection(db);}
        finally {if(db.inTransaction)db.exec('ROLLBACK');db.close();}
      }
      rows.push({source:item.source,status:'present',...state});continue;
    }
    if(input.action!=='snapshot') throw new Error(`Unknown action: ${input.action}`);
    const file=`${item.owner}.db`, target=path.join(input.stagingDir,file);
    const db=new Database(source,{readonly:true,fileMustExist:true,timeout:5000});
    try {if(typeof db.backup!=='function') throw new Error('SQLite backup API unavailable');await db.backup(target);}finally{db.close();}
    fs.chmodSync(target,0o600);
    // db.backup preserves the source WAL header. Normalize only our private
    // snapshot, leaving the original database and its committed WAL untouched.
    const snapshot = new Database(target, {fileMustExist:true, timeout:5000});
    try {
      if (snapshot.pragma('journal_mode=DELETE', {simple:true}) !== 'delete') throw new Error('Snapshot journal mode normalization failed');
    } finally { snapshot.close(); }
    const state=inspect(Database,target);
    const fd=fs.openSync(target,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    rows.push({source:item.source,status:'backed_up',...state,file,bytes:fs.statSync(target).size,sha256:hash(target)});
  }
  return {databases:rows};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))) {
  const timer=setTimeout(()=>{process.stderr.write('SQLite worker deadline exceeded\n');process.exit(1);},90000);
  try {process.stdout.write(JSON.stringify(await execute(JSON.parse(process.argv[2]))));}
  catch(error){process.stderr.write(error.stack+'\n');process.exitCode=1;}
  finally{clearTimeout(timer);}
}
