if (process.argv[2]) {
  process.setgid(Number(process.argv[2]));
  process.setuid(Number(process.argv[2]));
}
process.title = ['claude', '--dangerously-skip-permissions'].join(' ');
if (process.send) {
  process.send({ ready: true });
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ ready: true, pid: process.pid, uid: process.getuid() }));
  setTimeout(() => process.exit(0), 5000);
}
