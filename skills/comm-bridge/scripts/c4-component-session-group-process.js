import { spawn } from 'node:child_process';

const [script, endpoint] = process.argv.slice(2);
let child;
let reason;
let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
let timer;
const report = () => process.stdout.write(JSON.stringify({ reason: reason || null,
  output: stdout.toString('utf8'), stderr: [...stderr.toString('utf8')].slice(0, 200).join('') }));
try {
  child = spawn('node', [script, endpoint], { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
} catch (error) {
  reason = `could not start: ${error.code || 'UNKNOWN'}`;
  report();
}
if (child) {
  const stop = failure => {
    reason ??= failure;
    child.kill('SIGKILL');
    // A descendant retaining output pipes must not extend the query deadline.
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  };
  timer = setTimeout(() => stop('timed out after 5 s'), 5000);
  child.stdin.on('error', () => {});
  child.stdin.end();
  child.stdout.on('data', chunk => {
    if (reason) return;
    if (stdout.length + chunk.length > 4096) { stop('stdout exceeded 4096 bytes'); return; }
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on('data', chunk => {
    if (stderr.length < 800) stderr = Buffer.concat([stderr, chunk.subarray(0, 800 - stderr.length)]);
  });
  child.once('error', error => { reason ??= `could not start: ${error.code || 'UNKNOWN'}`; });
  child.once('close', code => {
    clearTimeout(timer);
    if (code !== 0) reason ??= `exit code ${code}`;
    report();
  });
}
