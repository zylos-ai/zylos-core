/* No Node ABI dependency. The JS caller validates/fixes executable and script
 * hashes before invoking this helper. Never installed setuid. */
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static int failure(const char *operation) {
  int saved = errno;
  fprintf(stderr, "%s: %s\n", operation, strerror(saved));
  printf("{\"status\":\"error\",\"errno\":%d}\n", saved);
  return 1;
}
static int number(const char *s, long min, long max, long *value) {
  char *end;
  errno = 0;
  long n = strtol(s, &end, 10);
  if (errno || !*s || *end || n < min || n > max) return 0;
  *value = n;
  return 1;
}
static int identity(pid_t pid) {
  struct kinfo_proc info;
  memset(&info, 0, sizeof(info));
  size_t size = sizeof(info);
  int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  if (sysctl(mib, 4, &info, &size, NULL, 0) < 0) return failure("process query");
  if (size == 0) {
    printf("{\"status\":\"absent\",\"pid\":%d}\n", pid);
    return 0;
  }
  if (size != sizeof(info) || info.kp_proc.p_pid != pid ||
      info.kp_proc.p_starttime.tv_sec <= 0 ||
      info.kp_proc.p_starttime.tv_usec < 0 || info.kp_proc.p_starttime.tv_usec >= 1000000) {
    errno = EPROTO;
    return failure("process identity structure");
  }
  char boot[128] = {0};
  size = sizeof(boot);
  if (sysctlbyname("kern.bootsessionuuid", boot, &size, NULL, 0) < 0)
    return failure("boot identity query");
  if (!size || size > sizeof(boot) || !memchr(boot, 0, size) || !boot[0] ||
      strspn(boot, "0123456789abcdefABCDEF-") != strlen(boot)) {
    errno = EPROTO;
    return failure("boot identity structure");
  }
  printf("{\"status\":\"present\",\"pid\":%d,\"boot\":\"%s\",\"start\":\"%lld:%06d\"}\n",
    pid, boot, (long long)info.kp_proc.p_starttime.tv_sec, info.kp_proc.p_starttime.tv_usec);
  return 0;
}
static long long milliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static int lock_exec(int argc, char **argv, long wait) {
  struct stat st;
  if (fstat(3, &st)) return failure("guard descriptor");
  if (!S_ISREG(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 077)) {
    errno = EPERM;
    return failure("unsafe guard descriptor");
  }
  if (argc < 5 || argv[3][0] != '/' || argv[4][0] != '/') {
    errno = EINVAL;
    return failure("absolute executable and script required");
  }
  long long now = milliseconds();
  if (now < 0) return failure("monotonic clock");
  long long deadline = now + wait;
  for (;;) {
    if (!flock(3, LOCK_EX | LOCK_NB)) break;
    if (errno != EWOULDBLOCK && errno != EINTR) return failure("guard lock");
    now = milliseconds();
    if (now < 0) return failure("monotonic clock");
    if (now >= deadline) {
      fprintf(stderr, "controller guard timeout\n");
      return 75;
    }
    struct timespec pause = {0, 10000000};
    nanosleep(&pause, NULL);
  }
  int flags = fcntl(3, F_GETFD);
  if (flags < 0 || fcntl(3, F_SETFD, flags & ~FD_CLOEXEC)) return failure("inherit guard");
  /* Parent still owns a reference. JS must close it in finally, including
   * timeout/error paths. No unlink or explicit unlock of this shared lock. */
  execv(argv[3], &argv[3]);
  return failure("controller exec");
}
int main(int argc, char **argv) {
  long value;
  if (argc == 2 && !strcmp(argv[1], "probe")) {
    puts("{\"protocol\":1,\"platform\":\"darwin\",\"status\":\"supported\"}");
    return 0;
  }
  if (argc == 3 && !strcmp(argv[1], "identity") && number(argv[2], 1, INT_MAX, &value))
    return identity((pid_t)value);
  if (argc >= 5 && !strcmp(argv[1], "lock-exec") && number(argv[2], 0, 5000, &value))
    return lock_exec(argc, argv, value);
  if (argc == 3 && !strcmp(argv[1], "fullsync") && number(argv[2], 3, INT_MAX, &value)) {
    if (fsync((int)value)) return failure("fsync");
    if (fcntl((int)value, F_FULLFSYNC)) return failure("F_FULLFSYNC");
    return 0;
  }
  fprintf(stderr, "usage: macos-recovery-helper probe | identity PID | lock-exec WAIT_MS ABS_NODE ABS_SCRIPT [ARGS...] | fullsync FD\n");
  return 64;
}
