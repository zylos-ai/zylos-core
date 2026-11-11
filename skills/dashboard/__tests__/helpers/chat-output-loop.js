import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(JSON.stringify({ child: child.pid }));
// Wait one turn so the PID receipt is captured before the bounded stream floods.
setInterval(() => process.stderr.write('x'.repeat(4096)), 10);
