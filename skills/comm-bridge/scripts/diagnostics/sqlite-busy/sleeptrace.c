#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1
#include <stdio.h>
#include <time.h>
static int (*originalSleep)(sqlite3_vfs*,int);
static double monotime(void){struct timespec ts;clock_gettime(CLOCK_MONOTONIC,&ts);return ts.tv_sec*1000.0+ts.tv_nsec/1e6;}
static int tracedSleep(sqlite3_vfs *vfs,int us){double start=monotime();int rc=originalSleep(vfs,us);fprintf(stderr,"{\"event\":\"vfs.xSleep\",\"start_mono_ms\":%.6f,\"requested_us\":%d,\"actual_ms\":%.6f,\"returned_us\":%d}\n",start,us,monotime()-start,rc);return rc;}
int sqlite3_sleeptrace_init(sqlite3 *db,char **error,const sqlite3_api_routines *api){SQLITE_EXTENSION_INIT2(api);sqlite3_vfs *vfs=sqlite3_vfs_find(0);originalSleep=vfs->xSleep;vfs->xSleep=tracedSleep;return SQLITE_OK;}
