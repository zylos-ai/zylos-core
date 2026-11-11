import { spawn } from 'node:child_process';
// A real descendant and recurring output make cleanup observable after a timeout.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(JSON.stringify({ child: child.pid }));
setInterval(() => process.stdout.write('tick\n'), 10);
