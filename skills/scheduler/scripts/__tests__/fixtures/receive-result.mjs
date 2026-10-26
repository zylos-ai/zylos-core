// Fault-only child: force retryable/unknown receipts and termination that the
// real receive success/rejection/committed-notice tests cannot deterministically produce.
import fs from 'node:fs';
const mode = process.env.RECEIVE_FIXTURE_MODE;
if (mode === 'timeout') {
  process.on('SIGTERM', () => {
    fs.writeFileSync(process.env.RECEIVE_FIXTURE_EXITED, 'exited');
    process.exit(1);
  });
  setInterval(() => {}, 1000);
} else if (mode === 'signal') {
  process.kill(process.pid, 'SIGTERM');
} else if (mode === 'invalid') {
  console.log('not json'); process.exitCode = 1;
} else if (mode === 'abnormal') {
  process.exitCode = 7;
} else {
  const [code, persisted] = mode.split(':');
  console.log(JSON.stringify({ok:false,error:{code,message:'contract fixture',persisted:JSON.parse(persisted)}}));
  process.exitCode = 1;
}
