#include <sqlite3ext.h>
#include <string.h>
SQLITE_EXTENSION_INIT1
static void steps(sqlite3_context *ctx,int argc,sqlite3_value **argv){
 sqlite3 *db=sqlite3_context_db_handle(ctx);
 const char *sql=(const char*)sqlite3_value_text(argv[0]);
 for(sqlite3_stmt *s=sqlite3_next_stmt(db,0);s;s=sqlite3_next_stmt(db,s)){
  if(sqlite3_sql(s)&&strcmp(sqlite3_sql(s),sql)==0){sqlite3_result_int(ctx,sqlite3_stmt_status(s,SQLITE_STMTSTATUS_VM_STEP,1));return;}
 }
 sqlite3_result_error(ctx,"statement not found",-1);
}
int sqlite3_vmstats_init(sqlite3 *db,char **err,const sqlite3_api_routines *api){
 SQLITE_EXTENSION_INIT2(api);
 return sqlite3_create_function(db,"test_vm_steps",1,SQLITE_UTF8,0,steps,0,0);
}
