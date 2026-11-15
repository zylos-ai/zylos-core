#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
int main(int argc, char **argv) {
  const char *binary = getenv("BENCH_TMUX_BIN"), *log = getenv("BENCH_TMUX_LOG");
  if (!binary || !log || argc < 2) return 125;
  pid_t child = fork();
  if (child == -1) return 125;
  if (!child) { argv[0] = (char *)binary; execv(binary, argv); _exit(127); }
  int status; struct rusage usage;
  if (wait4(child, &status, 0, &usage) != child) return 125;
  int fd = open(log, O_WRONLY|O_CREAT|O_APPEND, 0600);
  if (fd == -1) return 125;
  dprintf(fd, "%ld %ld\n", usage.ru_utime.tv_sec * 1000000 + usage.ru_utime.tv_usec,
    usage.ru_stime.tv_sec * 1000000 + usage.ru_stime.tv_usec);
  close(fd);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
