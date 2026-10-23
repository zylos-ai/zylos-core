/* Core-owned private stdio helper. No PID-number signal fallback. */
#define _GNU_SOURCE
#include <sys/syscall.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(__linux__) || !defined(SYS_pidfd_open) || !defined(SYS_pidfd_send_signal)
#error Linux headers with pidfd syscalls are required
#endif

static void answer(const char *text) { puts(text); fflush(stdout); }
static void failure(void) { printf("ERR %d\n", errno); fflush(stdout); }
int main(int argc, char **argv) {
    char *end = NULL;
    if (argc != 2) return 2;
    errno=0;
    long pid=strtol(argv[1], &end, 10);
    if (errno || !end || *end || pid <= 0 || pid > INT_MAX) return 2;
    int fd=(int)syscall(SYS_pidfd_open, (int)pid, 0);
    if (fd < 0) {
        if (errno == ESRCH) { answer("GONE"); return 0; }
        failure(); return 1;
    }
    answer("READY");
    char command[16];
    while (fgets(command, sizeof(command), stdin)) {
        int sig;
        if (!strcmp(command, "TERM\n")) sig=SIGTERM;
        else if (!strcmp(command, "KILL\n")) sig=SIGKILL;
        else { close(fd); return 2; }
        if (syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0) == 0) answer("OK");
        else if (errno == ESRCH) answer("GONE");
        else failure();
    }
    close(fd);
    return ferror(stdin) ? 1 : 0;
}
