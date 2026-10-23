/* Diagnostic only; no runtime dependency or installation.
 * macOS: cc -Wall -Wextra -Werror darwin-observation-probe.c -lproc -o /tmp/p02-darwin-probe
 *        /tmp/p02-darwin-probe
 * Only reads a child it creates with synthetic arguments/environment.
 */
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <signal.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int fail(const char *stage) {
    fprintf(stderr, "{\"result\":\"unavailable\",\"stage\":\"%s\",\"errno\":%d}\n", stage, errno);
    return 1;
}
static char *entry(char **cursor, char *end) {
    if (*cursor >= end) return NULL;
    char *value = *cursor;
    char *nul = memchr(value, 0, (size_t)(end-value));
    if (!nul) return NULL;
    *cursor = nul+1;
    return value;
}
static int observe(pid_t pid, const char *exe, const char *cwd) {
    struct proc_bsdinfo before, after;
    struct proc_vnodepathinfo vnode;
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != (int)sizeof(before)) return fail("identity-before");
    if (before.pbi_uid != getuid() || before.pbi_pid != (unsigned)pid) return fail("owner");
    if (proc_pidpath(pid, executable, sizeof(executable)) <= 0) return fail("executable");
    if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &vnode, sizeof(vnode)) != (int)sizeof(vnode)) return fail("cwd");
    int argmax = 0, mib[] = {CTL_KERN, KERN_ARGMAX};
    size_t length = sizeof(argmax);
    if (sysctl(mib, 2, &argmax, &length, NULL, 0) || argmax <= 0) return fail("argmax");
    char *buffer = calloc((size_t)argmax, 1);
    if (!buffer) return fail("allocate");
    int args_mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
    length = (size_t)argmax;
    if (sysctl(args_mib, 3, buffer, &length, NULL, 0)) { free(buffer); return fail("procargs2"); }
    int result = 1, argc = 0, run = 0, model = 0, group = 0;
    if (length < sizeof(argc)) goto done;
    memcpy(&argc, buffer, sizeof(argc));
    char *cursor = buffer+sizeof(argc), *end = buffer+length;
    if (!entry(&cursor, end)) goto done; /* executable-path prefix */
    while (cursor < end && *cursor == 0) cursor++;
    const char *wanted[] = {exe, "--child", "", "argument with spaces"};
    if (argc != 4) goto done;
    for (int i=0; i<argc; i++) {
        char *value = entry(&cursor, end);
        if (!value || strcmp(value, wanted[i])) goto done;
    }
    while (cursor < end && *cursor) {
        char *value = entry(&cursor, end);
        if (!value) goto done;
        if (!strcmp(value, "ZYLOS_RUN_ID=synthetic-darwin-probe")) run++;
        if (!strcmp(value, "ZYLOS_MODEL_CONFIG={\"runtime\":\"claude\",\"mode\":\"default\"}")) model++;
        if (!strncmp(value, "ZYLOS_SESSION_GROUP=", 20)) group++;
    }
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != (int)sizeof(after)) goto done;
    if (before.pbi_pid != after.pbi_pid || before.pbi_uid != after.pbi_uid ||
        before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec) goto done;
    if (strcmp(executable, exe) || strcmp(vnode.pvi_cdir.vip_path, cwd) || run!=1 || model!=1 || group) goto done;
    printf("{\"result\":\"observed\",\"pid\":%d,\"startSeconds\":%llu,\"startMicroseconds\":%llu,\"exactArgv\":true,\"emptyArgument\":true,\"syntheticEnvironment\":true,\"cwd\":true,\"exe\":true,\"sameIncarnation\":true}\n",
        pid, (unsigned long long)before.pbi_start_tvsec, (unsigned long long)before.pbi_start_tvusec);
    result=0;
done:
    free(buffer);
    return result ? fail("incomplete-or-mismatched-image") : 0;
}
int main(int argc, char **argv) {
    if (argc>1 && !strcmp(argv[1], "--child")) {
        if (write(3, "r", 1)!=1) return 2;
        close(3);
        for (;;) pause();
    }
    char exe[PATH_MAX], directory[]="/tmp/p02-darwin-XXXXXX", cwd[PATH_MAX];
    if (!realpath(argv[0], exe) || !mkdtemp(directory) || !realpath(directory, cwd)) return fail("fixture-path");
    int ready[2];
    if (pipe(ready)) { rmdir(directory); return fail("pipe"); }
    pid_t child=fork();
    if (child==0) {
        close(ready[0]);
        if (ready[1]!=3) { if (dup2(ready[1], 3)<0) _exit(2); close(ready[1]); }
        if (chdir(cwd)) _exit(2);
        char *args[]={exe,"--child","","argument with spaces",NULL};
        char *env[]={"ZYLOS_RUN_ID=synthetic-darwin-probe","ZYLOS_MODEL_CONFIG={\"runtime\":\"claude\",\"mode\":\"default\"}",NULL};
        execve(exe,args,env); _exit(2);
    }
    close(ready[1]);
    int result=1; char byte;
    if (child>0 && read(ready[0],&byte,1)==1 && byte=='r') result=observe(child,exe,cwd);
    else fail("fixture-exec");
    close(ready[0]);
    if (child>0) { kill(child,SIGKILL); waitpid(child,NULL,0); }
    rmdir(directory);
    return result;
}
#else
#include <stdio.h>
int main(void) {
    puts("{\"result\":\"not-run\",\"reason\":\"requires-macOS-native-libproc-and-sysctl\"}");
    return 78;
}
#endif
