import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Released manifests are test data, never created by the current snapshot API.
export async function createReleasedSnapshotFixture({Database,zylosDir,transactionId,formatVersion,snapshot}) {
  const result=snapshot({zylosDir,transactionId});
  if(formatVersion===3) return result;
  const source='web-console/web-console.db',file=path.join(zylosDir,source);
  let web={source,status:'missing',file:null,bytes:0,sha256:null,userVersion:null,integrityCheck:null};
  if(fs.existsSync(file)) {
    const copy=path.join(result.dbBackupDir,'web-console.db'),db=new Database(file,{readonly:true,fileMustExist:true});
    try {await db.backup(copy);} finally {db.close();}
    const normalized=new Database(copy);let userVersion;
    try {normalized.pragma('journal_mode=DELETE');userVersion=normalized.pragma('user_version',{simple:true});} finally {normalized.close();}
    web={source,status:'backed_up',file:'web-console.db',bytes:fs.statSync(copy).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(copy)).digest('hex'),userVersion,integrityCheck:'ok'};
  }
  const databases=[...result.manifest.databases.slice(0,2),web,...(formatVersion===2?result.manifest.databases.slice(2):[])];
  result.manifest={...result.manifest,formatVersion,databases};
  fs.writeFileSync(path.join(result.dbBackupDir,'manifest.json'),JSON.stringify(result.manifest,null,2)+'\n');
  return result;
}
