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
function quote(name) {return '"'+name.replaceAll('"','""')+'"';}
function encode(value) {
  if(value===null) return ['null'];
  if(Buffer.isBuffer(value)) return ['blob',value.toString('hex')];
  if(typeof value==='bigint') return ['integer',value.toString()];
  if(typeof value==='number') return ['real',Object.is(value,-0)?'-0':String(value)];
  return ['text',value];
}
// Hash SQLite values, not DB/WAL/SHM bytes. A readonly transaction fixes the
// committed snapshot while schema, rows, integrity and version are inspected.
export function logicalHash(db) {
  const digest=crypto.createHash('sha256');
  digest.update(JSON.stringify({userVersion:db.pragma('user_version',{simple:true}),applicationId:db.pragma('application_id',{simple:true})})+'\n');
  const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').raw().all();
  digest.update(JSON.stringify(schema)+'\n');
  for(const row of schema.filter(row=>row[0]==='table')) {
    const name=row[1];
    const columns=db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(column=>column.name.toLowerCase());
    const alias=['rowid','_rowid_','oid'].find(value=>!columns.includes(value));
    const hasRowid=alias&&!/WITHOUT\s+ROWID/i.test(row[3]||'');
    const query=`SELECT ${hasRowid?quote(alias)+', ':''}* FROM ${quote(name)}`;
    const data=db.prepare(query).safeIntegers(true).raw().all().map(values=>JSON.stringify(values.map(encode))).sort();
    digest.update(JSON.stringify(name)+'\n');
    for(const encoded of data) digest.update(encoded+'\n');
  }
  return digest.digest('hex');
}
function inspectConnection(db) {
  const checks=db.pragma('integrity_check');
  if(checks.length!==1 || Object.values(checks[0])[0]!=='ok') throw new Error('integrity_check failed');
  return {userVersion:db.pragma('user_version',{simple:true}),integrityCheck:'ok',logicalHash:logicalHash(db)};
}
function inspect(Database,file) {
  const db = new Database(file,{readonly:true,fileMustExist:true,timeout:5000});
  try {db.exec('BEGIN');return inspectConnection(db);}
  finally {if(db.inTransaction)db.exec('ROLLBACK');db.close();}
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
      const state=inspect(driver(input,item),file);
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
      const db=new Database(source,{readonly:true,fileMustExist:true,timeout:5000});
      let state;
      try {db.exec('BEGIN');mod.inspectSchema(db);state=inspectConnection(db);}
      finally {if(db.inTransaction)db.exec('ROLLBACK');db.close();}
      rows.push({source:item.source,status:'present',...state});continue;
    }
    if(input.action!=='snapshot') throw new Error(`Unknown action: ${input.action}`);
    const file=`${item.owner}.db`, target=path.join(input.stagingDir,file);
    const db=new Database(source,{readonly:true,fileMustExist:true,timeout:5000});
    try {if(typeof db.backup!=='function') throw new Error('SQLite backup API unavailable');await db.backup(target);}finally{db.close();}
    fs.chmodSync(target,0o600);
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
