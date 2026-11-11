import {inspectLayout} from '../../../../skills/comm-bridge/scripts/sqlite-schema.js';
import {migrateSchema} from './legacy-web-console-migrations.js';

// Released Web Console layout retained solely for old deployment fixtures.
export const SUPPORTED_SCHEMA_VERSION = 1;
export const supportsNewDatabase = true;
export const MIGRATIONS = Object.freeze({0:Object.freeze({to:1,migrate:migrateSchema})});
export const TABLES = {sessions:['token','created_at','last_seen_at'],uploads:['id','session_token','path','name','size','size_label','mime','kind','created_at','consumed']};
export const COLUMN_DEFINITIONS = Object.fromEntries(Object.entries(TABLES).map(([table,columns])=>[table,Object.fromEntries(columns.map(name=>[name,{type:['created_at','last_seen_at','size','consumed'].includes(name)?'INTEGER':'TEXT',pk:table==='sessions'?name==='token':name==='id'}]))]));
export function inspectSchema(db,{allowNew=false,strict=true,allowExtraTables,allowExtraColumns,rejectUnsafeExtensions=strict}={}) {
  return inspectLayout(db,'web-console',SUPPORTED_SCHEMA_VERSION,TABLES,{allowNew,strict,allowExtraTables,allowExtraColumns,rejectUnsafeExtensions,definitions:COLUMN_DEFINITIONS,migrateFromOlder:true});
}
