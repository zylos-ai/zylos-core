import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const LEGACY_CORE_DATABASES = Object.freeze([
  {source:'comm-bridge/c4.db',owner:'comm-bridge',schema:'scripts/c4-schema.js'},
  {source:'scheduler/scheduler.db',owner:'scheduler',schema:'scripts/schema.js'},
  {source:'web-console/web-console.db',owner:'web-console',schema:'scripts/schema.js'},
]);
export const CORE_DATABASES = Object.freeze([...LEGACY_CORE_DATABASES,
  {source:'components/dashboard/dashboard.db',owner:'dashboard',schema:'src/lib/schema-owner.js'},
]);
export function databasesForFormat(formatVersion=2) {
  if(formatVersion===1) return LEGACY_CORE_DATABASES;
  if(formatVersion===2) return CORE_DATABASES;
  throw Error(`Unsupported database snapshot format: ${formatVersion}`);
}
export function validateSnapshotManifest(manifest) {
  if(![1,2].includes(manifest?.formatVersion)) throw Error(`Unsupported database snapshot format: ${manifest?.formatVersion}`);
  const items=databasesForFormat(manifest?.formatVersion);
  if(manifest?.function!=='core-self-upgrade-db'||manifest.status!=='complete'||typeof manifest.id!=='string'||!Array.isArray(manifest.databases)||manifest.databases.length!==items.length) throw Error('Incomplete snapshot group');
  for(const item of items) {
    const matches=manifest.databases.filter(row=>row.source===item.source);
    if(matches.length!==1) throw Error(`Invalid snapshot source: ${item.source}`);
    const row=matches[0];
    if(row.status==='missing') {
      if(row.file!==null||row.bytes!==0||row.sha256!==null||row.userVersion!==null||row.integrityCheck!==null) throw Error('Invalid missing snapshot entry');
    } else if(row.status!=='backed_up'||row.integrityCheck!=='ok'||typeof row.file!=='string'||row.file!==`${item.owner}.db`||!Number.isSafeInteger(row.bytes)||row.bytes<=0||!Number.isInteger(row.userVersion)||row.userVersion<0||!/^[a-f0-9]{64}$/.test(row.sha256)) throw Error('Invalid snapshot entry');
  }
  return items;
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function schemaError(message, code, cause) {
  return Object.assign(new Error(message), {code:cause?.code === 'SCHEMA_TOO_NEW' ? cause.code : code});
}
function failureResult(error) {
  // Dependency loaders can put source paths and require stacks in message.
  const message=String(error.message || error).split('\n')[0]
    .replace(/(^|[\s('"`])(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)[^\s'"`,;:)]+/g,'$1<path>');
  const code=['SCHEMA_TOO_NEW','SCHEMA_MIGRATION_FAILED'].includes(error.code) ? error.code : 'UPGRADE_FAILED';
  return {ok:false,error:{code,message}};
}
function driver(input) {
  if(input.driverPath) return createRequire(import.meta.url)(input.driverPath);
  const root=input.driverRoot || path.join(input.zylosDir,'.claude','skills');
  return createRequire(path.join(root,'comm-bridge/package.json'))('better-sqlite3');
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
  if(item.owner==='dashboard') {
    const root=path.join(input.schemaRoot || path.join(input.zylosDir,'.claude','skills'),'dashboard');
    try {
      const mod=await import(pathToFileURL(path.join(root,item.schema)));
      const owner=mod.dashboardSchemaOwner;
      if(!owner||['inspectSchema','migrate'].some(name=>typeof owner[name]!=='function')) throw Error('missing dashboardSchemaOwner contract');
      return owner;
    } catch(error) {throw Error(`Incompatible owner schema code dashboard: ${error.message}`);}
  }
  const schemaPath=path.join(input.schemaRoot || path.join(input.zylosDir,'.claude','skills'),item.owner,item.schema);
  try {
    const mod=await import(pathToFileURL(schemaPath));
    if(typeof mod.inspectSchema!=='function'||typeof mod.supportsNewDatabase!=='boolean') throw new Error('missing pure schema inspection contract');
    if (!mod.TABLES || typeof mod.TABLES !== 'object') throw new Error('missing schema table contract');
    // Owners classify extensions against their own current layout. Older
    // versions have no latest-layout comparison until their migration runs.
    return {
      ...mod,
      inspectSchema(db, options = {}) {
        const result = mod.inspectSchema(db, {...options, strict:false, rejectUnsafeExtensions:true});
        if (!result.extensions || !Array.isArray(result.extensions.tables) || !Array.isArray(result.extensions.columns)) throw new Error('missing schema extension report');
        return result;
      }
    };
  }catch(error){throw new Error(`Incompatible owner schema code ${item.owner}: ${error.message}`);}
}
async function migrationEngine(input) {
  const root=input.schemaRoot || path.join(input.zylosDir,'.claude','skills');
  try {return await import(pathToFileURL(path.join(root,'comm-bridge/scripts/sqlite-schema.js')));}
  catch(error) {throw Error('Incompatible owner schema code comm-bridge: '+error.message);}
}
function authorizeMigration(input) {
  if(typeof input.transactionDir!=='string' || typeof input.transactionId!=='string') throw Error('controlled migration requires transaction identity');
  const root=fs.realpathSync(input.zylosDir);
  // This module is retained outside the replaced package and sqlite closure.
  const m=createRequire(import.meta.url)(path.join(root,'.zylos/upgrade/maintenance.cjs'));
  const marker=m.read(path.join(root,'.zylos/upgrade/active.json'));
  const dir=input.transactionDir;
  if(marker.formatVersion!==1 || marker.transactionDir!==dir || marker.transactionId!==input.transactionId) throw Error('controlled migration active identity mismatch');
  const j=m.transaction(root,dir);
  if(j.transactionId!==input.transactionId || j.phase!=='installing' || j.installationIntent!==true || j.skillsDir!==path.join(root,'.claude/skills') || input.schemaRoot && input.schemaRoot!==j.skillsDir) throw Error('controlled migration requires active installing transaction');
  if(j.dbBackupDir!==path.join(root,'.backup/db',j.transactionId) || m.hash(path.join(j.dbBackupDir,'manifest.json'))!==j.snapshotManifestHash) throw Error('controlled migration snapshot identity mismatch');
  return j;
}
export async function execute(input) {
  if(!['probe','snapshot','verify','offline-preflight','upgrade-migrate','rehearse','version-probe','dashboard-state'].includes(input.action)) throw new Error(`Unknown action: ${input.action}`);
  if(input.action==='dashboard-state') {
    const source=path.join(input.zylosDir,'components/dashboard/dashboard.db');
    if(missing(source)) return {dashboardOwnerManaged:false};
    const Database=driver(input),db=new Database(source,{readonly:true,fileMustExist:true,timeout:5000});
    try {
      const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
      const version=table ? db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version : null;
      if(version!==null && (!Number.isSafeInteger(version)||version<0)) throw Error('Invalid Dashboard migration version');
      return {dashboardOwnerManaged:version!==null && version>=20};
    } finally {db.close();}
  }
  if(input.action==='snapshot' && input.formatVersion!==undefined && input.formatVersion!==2) throw Error('New database snapshots require formatVersion 2');
  if(input.action==='probe') {
    const Database=createRequire(import.meta.url)(input.driverPath); const db=new Database(':memory:');
    try {if(typeof db.backup!=='function') throw new Error('SQLite backup API unavailable');}finally{db.close();}
    return {ok:true};
  }
  // Original deployment verification has presence evidence, not a snapshot.
  // Keep that capability separate from complete-manifest validation.
  let databases;
  if(input.action==='offline-preflight' && input.expectedDatabases) {
    const rows=input.expectedDatabases;
    databases=databasesForFormat(input.formatVersion ?? (rows?.length===3 ? 1 : 2));
    if(!Array.isArray(rows)||rows.length!==databases.length||databases.some((item,index)=>rows[index]?.source!==item.source||!['complete','missing'].includes(rows[index].status))) throw Error('Invalid original database presence evidence');
  } else databases=input.manifest ? validateSnapshotManifest(input.manifest) : databasesForFormat(input.formatVersion ?? 2);
  const inspectDashboard=async (owner,db) => {
    const state=await owner.inspectSchema(db);
    if(!state||!Number.isInteger(state.targetVersion)||state.targetVersion<0||!Number.isInteger(state.currentVersion)||state.currentVersion<0||typeof state.needsMigration!=='boolean') throw Error('Invalid dashboard schema inspection');
    if(state.currentVersion>state.targetVersion) throw schemaError(`SCHEMA_TOO_NEW dashboard: schema version ${state.currentVersion} exceeds supported ${state.targetVersion}`,'SCHEMA_TOO_NEW');
    if(input.requireCurrent && state.needsMigration) throw Error('Database migrations remain before data-ready');
    return state;
  };
  const inspectDashboardFile=async (owner,file) => {
    const Database=driver(input);
    const db=new Database(file,{readonly:true,fileMustExist:true,timeout:5000});
    try {return await inspectDashboard(owner,db);} finally {db.close();}
  };
  const skipDashboard=item=>input.dashboardOwnerManaged===false && item.owner==='dashboard';
  if(input.action==='version-probe') {
    if (!input.schemaRoot || !input.driverRoot) throw Error('Version probe requires target schema and installed driver roots');
    const rows=[];
    for(const item of databases) {
      if(skipDashboard(item)) continue;
      if(item.owner==='dashboard' && missing(path.join(input.zylosDir,item.source))) {
        rows.push({source:item.source,status:'missing',fromVersion:null,toVersion:null,needsMigration:false});
        continue;
      }
      const mod=await ownerSchema(input,item);
      if(item.owner==='dashboard') {
        const source=path.join(input.zylosDir,item.source);
        const state=await inspectDashboardFile(mod,source);
        rows.push({source:item.source,status:'present',fromVersion:state.currentVersion,toVersion:state.targetVersion,needsMigration:state.needsMigration});
        continue;
      }
      const target=mod.SUPPORTED_SCHEMA_VERSION;
      if(!Number.isInteger(target)||target<0) throw Error(`Invalid target schema version: ${item.owner}`);
      const source=path.join(input.zylosDir,item.source);
      if(missing(source)) {
        if(!mod.supportsNewDatabase) throw Error(`Owner cannot initialize missing database: ${item.owner}`);
        rows.push({source:item.source,status:'missing',fromVersion:null,toVersion:target,needsMigration:true});
        continue;
      }
      const Database=driver(input,item);
      const db=new Database(source,{readonly:true,fileMustExist:true,timeout:5000});
      let current;
      try {current=mod.inspectSchema(db,{allowNew:false,strict:false}).version;} finally {db.close();}
      if(!Number.isInteger(current)||current<0) throw Error(`${item.source}: invalid schema version ${current}`);
      if(current>target) throw schemaError(`${item.source}: schema version ${current} exceeds supported ${target}; restore compatible code/data`,'SCHEMA_TOO_NEW');
      rows.push({source:item.source,status:'present',fromVersion:current,toVersion:target,needsMigration:current<target});
    }
    return {databases:rows,needsMigration:rows.some(row=>row.needsMigration)};
  }
  if(input.action==='upgrade-migrate') {
    const transaction=authorizeMigration(input);
    if(typeof transaction.dashboardOwnerManaged!=='boolean')throw Error('controlled migration requires persisted Dashboard owner state');
    input={...input,dashboardOwnerManaged:transaction.dashboardOwnerManaged};
  }
  const engine=['offline-preflight','upgrade-migrate','rehearse'].includes(input.action) ? await migrationEngine(input) : null;
  if(input.action==='rehearse') {
    if (!input.schemaRoot || !input.driverRoot || !input.rehearsalDir) throw Error('Rehearsal requires target schema, installed driver, and private copy roots');
    const directory=input.rehearsalDir;
    const stat=fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe private rehearsal directory');
    const reports=[];
    try {
      for(const item of databases) {
        if(skipDashboard(item)) continue;
        const source=path.join(input.zylosDir,item.source);
        if(item.owner==='dashboard' && missing(source)) {reports.push({source:item.source,status:'missing'});continue;}
        const mod=await ownerSchema(input,item),Database=driver(input,item);
        const absent=missing(source);
        if(item.owner==='dashboard') {
          const before=await inspectDashboardFile(mod,source);
          const target=path.join(directory,'dashboard.db');
          const live=new Database(source,{readonly:true,fileMustExist:true,timeout:5000});try {await live.backup(target);}finally{live.close();}
          const copy=new Database(target,{fileMustExist:true,timeout:5000});
          let after;
          try {await mod.migrate(copy);after=await inspectDashboard(mod,copy);}
          catch(error) {throw schemaError(`SCHEMA_MIGRATION_FAILED dashboard rehearsal: ${error.message}`,'SCHEMA_MIGRATION_FAILED',error);}
          finally {copy.close();}
          if(after.needsMigration) throw schemaError('SCHEMA_MIGRATION_FAILED dashboard rehearsal remains incomplete','SCHEMA_MIGRATION_FAILED');
          reports.push({source:item.source,status:'present',fromVersion:before.currentVersion,toVersion:after.currentVersion});
          continue;
        }
        if(absent && !mod.supportsNewDatabase) throw Error(`Owner cannot initialize missing database: ${item.owner}`);
        const target=path.join(directory,`${item.owner}.db`);
        if(!absent) {
          const live=new Database(source,{readonly:true,fileMustExist:true,timeout:5000});
          try {await live.backup(target);} finally {live.close();}
        }
        const copy=new Database(target,{fileMustExist:!absent,timeout:5000});
        try {
          inspectConnection(copy);
          const start=copy.pragma('user_version',{simple:true});
          const result=engine.migrateDatabase(copy,mod,{allowNew:absent,strict:false});
          reports.push({source:item.source,status:absent?'missing':'present',fromVersion:start,toVersion:result.version,extensions:result.extensions});
        } catch(error) {throw schemaError(`${item.source}: rehearsal failed: ${error.message}`,'SCHEMA_MIGRATION_FAILED',error);} finally {copy.close();}
      }
      return {databases:reports};
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  }
  const plan=(db,mod,options={}) => {
    // A restored pre-chain owner still supplies its original readonly contract.
    if(typeof engine.planDatabaseMigration==='function') {
      const result=engine.planDatabaseMigration(db,mod,{...options,strict:true});
      if(input.requireCurrent && (result.steps.length || result.empty)) throw Error('Database migrations remain before data-ready');
      return result;
    }
    if(input.requireCurrent) throw Error('Installed migration planner unavailable');
    return mod.inspectSchema(db,{...options,strict:true});
  };
  const rows=[];
  const standaloneSnapshot=input.action==='offline-preflight' && input.manifest?.status==='complete' && input.requireCurrent!==true;
  for(const item of databases) {
    if(skipDashboard(item) && ['offline-preflight','upgrade-migrate'].includes(input.action)) {
      // Legacy Dashboard bytes remain protected without invoking its new owner.
      const source=path.join(input.zylosDir,item.source),absent=missing(source);
      const expected=input.action==='offline-preflight' && input.requireCurrent ? undefined : (input.expectedDatabases ?? input.manifest?.databases)?.find(row=>row.source===item.source);
      if(input.action==='offline-preflight') {
        if(expected && absent && expected.status!=='missing') throw Error(`Expected database absent: ${source}`);
        const preserveMissingDashboard=standaloneSnapshot && item.owner==='dashboard' && expected?.status==='missing' && !absent;
        if(expected?.status==='missing' && !absent && !preserveMissingDashboard) throw Error(`Expected missing database exists: ${source}`);
        if(preserveMissingDashboard) {rows.push({source:item.source,status:'present',ownerSkipped:true});continue;}
        if(!absent) {
          const Database=driver(input);
          if(standaloneSnapshot) {
            if(expected?.status!=='backed_up') throw Error('Missing standalone restored snapshot evidence');
            withStandaloneReadonly(Database,source,expected.sha256,inspectConnection);
          } else {
            const db=new Database(source,{readonly:true,fileMustExist:true,timeout:5000});
            try {inspectConnection(db);} finally {db.close();}
          }
        }
      }
      rows.push({source:item.source,status:absent?'missing':'present',ownerSkipped:true});
      continue;
    }
    const expected=input.action==='offline-preflight' && input.requireCurrent ? undefined : (input.expectedDatabases ?? input.manifest?.databases)?.find(r=>r.source===item.source);
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
    if(input.action==='upgrade-migrate') {
      // Recheck the durable capability before each owner.
      authorizeMigration(input);
      const absent=missing(source);
      if(item.owner==='dashboard' && absent) {rows.push({source:item.source,status:'missing'});continue;}
      const mod=await ownerSchema(input,item);
      if(item.owner==='dashboard') {
        await inspectDashboardFile(mod,source);
        const Database=driver(input),db=new Database(source,{fileMustExist:true,timeout:5000});
        let state;
        try {await mod.migrate(db);state=await inspectDashboard(mod,db);}
        catch(error) {throw schemaError(`SCHEMA_MIGRATION_FAILED ${item.source}: ${error.message}`,'SCHEMA_MIGRATION_FAILED',error);}
        finally {db.close();}
        if(state.needsMigration) throw schemaError('SCHEMA_MIGRATION_FAILED dashboard migration remains incomplete','SCHEMA_MIGRATION_FAILED');
        rows.push({source:item.source,status:'present',...state});
        continue;
      }
      if(absent&&!mod.supportsNewDatabase) throw Error(`Owner cannot initialize missing database: ${item.owner}`);
      if(typeof engine.migrateDatabase!=='function') throw Error('Installed migration engine unavailable');
      const Database=driver(input,item);
      // Validate creation before creating even an empty business file.
      if(absent) {const memory=new Database(':memory:');try {plan(memory,mod,{allowNew:true});}finally{memory.close();}}
      fs.mkdirSync(path.dirname(source),{recursive:true});
      const db=new Database(source,{fileMustExist:!absent,timeout:5000});
      try {const layout=engine.migrateDatabase(db,mod,{allowNew:absent,strict:true});rows.push({source:item.source,status:'present',...inspectConnection(db),extensions:layout.extensions});}
      catch(error) {throw schemaError(`${item.source}: migration failed: ${error.message}`,'SCHEMA_MIGRATION_FAILED',error);}
      finally {db.close();}
      continue;
    }
    if(input.action==='offline-preflight' && item.owner==='dashboard') {
      const absent=missing(source);
      if(expected && absent && expected.status!=='missing') throw Error(`Expected database absent: ${source}`);
      const preserveMissingDashboard=standaloneSnapshot && expected?.status==='missing' && !absent;
      if(expected?.status==='missing' && !absent && !preserveMissingDashboard) throw Error(`Expected missing database exists: ${source}`);
      if(absent) {rows.push({source:item.source,status:'missing'});continue;}
      if(preserveMissingDashboard) {rows.push({source:item.source,status:'present'});continue;}
      const mod=await ownerSchema(input,item);
      if(standaloneSnapshot) {
        if(expected?.status!=='backed_up') throw Error('Missing standalone restored snapshot evidence');
        withStandaloneReadonly(driver(input,item),source,expected.sha256,inspectConnection);
      }
      const state=await inspectDashboardFile(mod,source);
      const db=new (driver(input,item))(source,{readonly:true,fileMustExist:true,timeout:5000});
      try {inspectConnection(db);}finally{db.close();}
      rows.push({source:item.source,status:'present',...state});
      continue;
    }
    const absent=missing(source);
    if(absent) {
      if(expected&&expected.status!=='missing') throw new Error(`Expected database absent: ${source}`);
      if(input.action==='offline-preflight') {
        const mod=await ownerSchema(input,item);
        if(!mod.supportsNewDatabase) throw new Error(`Owner cannot initialize missing database: ${item.owner}`);
        // Loading a pure module alone does not prove the actual Node/native
        // driver combination can perform the owner's first database creation.
        const Database=driver(input,item), memory=new Database(':memory:');
        try {plan(memory,mod,{allowNew:true});}finally{memory.close();}
      }
      rows.push({source:item.source,status:'missing',userVersion:null,file:null,bytes:0,sha256:null,integrityCheck:null});continue;
    }
    if(expected?.status==='missing') throw new Error(`Expected missing database exists: ${source}`);
    const Database=driver(input,item);
    if(input.action==='offline-preflight') {
      const mod=await ownerSchema(input,item);
      let state;
      if (standaloneSnapshot) {
        if (input.manifest?.status !== 'complete' || expected?.status !== 'backed_up' || typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('Missing standalone restored snapshot evidence');
        state = withStandaloneReadonly(Database, source, expected.sha256, db => {const layout=plan(db,mod); return {...inspectConnection(db),extensions:layout.extensions};});
      } else {
        // Original/preinstall and active READY verification must see committed
        // live WAL data. Never treat those databases as standalone snapshots.
        const db=new Database(source,{readonly:true,fileMustExist:true,timeout:5000});
        try {db.exec('BEGIN');const layout=plan(db,mod);state={...inspectConnection(db),extensions:layout.extensions};}
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
// Node resolves module URLs through symlinks; argv may retain the alias.
function isMainModule() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if(isMainModule()) {
  const timer=setTimeout(()=>{process.stdout.write(JSON.stringify(failureResult(Error('SQLite worker deadline exceeded')))+'\n');process.exit(1);},90000);
  try {process.stdout.write(JSON.stringify(await execute(JSON.parse(process.argv[2]))));}
  catch(error){process.stdout.write(JSON.stringify(failureResult(error))+'\n');process.exitCode=1;}
  finally{clearTimeout(timer);}
}
