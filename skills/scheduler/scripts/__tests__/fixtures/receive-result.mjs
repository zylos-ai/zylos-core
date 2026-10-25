// Contract fixture for the short-lived receive process, not a P09 implementation.
import fs from 'node:fs';
const mode = process.env.RECEIVE_FIXTURE_MODE;
if (process.env.RECEIVE_FIXTURE_RECORD) fs.writeFileSync(process.env.RECEIVE_FIXTURE_RECORD, JSON.stringify(process.argv.slice(2)));
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
} else if (mode === 'success') {
  console.log(JSON.stringify({ok:true,action:'queued',id:1,sessionGroup:'origin',runtime:'claude'}));
} else {
  const [code, persisted] = mode.split(':');
  console.log(JSON.stringify({ok:false,error:{code,message:'contract fixture',persisted:JSON.parse(persisted)}}));
  process.exitCode = 1;
}
